// spiral-guard.ts -- failure-spiral detection plugin for opencode.
//
// Watches tool results for REPEATING failures and read-without-write
// loops, and nudges the model (toast + text appended to the failing
// tool's own output) to change approach or delegate -- before the spiral
// burns the rest of the session. Complements opencode's built-in
// `doom_loop` ask (identical repeated calls, human interrupt) by covering
// the classes it cannot see: failures with DIFFERENT arguments each
// attempt (an identical-call matcher misses them), read-without-write
// circling (nothing failed, nothing repeated), and recovery coaching that
// never needs a human in the loop.
//
// Derived from a third-party draft whose escalation ladder and injection
// mechanics targeted a different agent/host; both were rewritten for
// opencode's real plugin API and delivery here. Ported to the opencode
// 2.0 plugin API (Plugin.define + ctx.tool.hook("execute.after")) --
// the 1.x hooks-object export shape and the injected `$` shell no longer
// exist in 2.0.
//
// NUDGE-ONLY by design: never auto-delegates, never blocks a tool call,
// never swallows errors. Worst case you see a toast you ignore.
//
// Tuning (env vars, no code edits needed):
//   SPIRAL_GUARD_FAIL_THRESHOLD   SOFT trigger after N consecutive failures (default 2)
//   SPIRAL_GUARD_HARD_THRESHOLD   HARD trigger after N consecutive failures (default 3)
//   SPIRAL_GUARD_READ_SPY         toast after N reads of one file with no write (default 3)
//   SPIRAL_GUARD_MAX_FIRES        max SOFT+HARD injections per target per session (default 2)
//   SPIRAL_GUARD_DELEGATE_HINT    optional hint naming YOUR delegation
//                                 target(s), e.g. "a cheap subagent for
//                                 mechanical work" -- spliced into the
//                                 SOFT/HARD nudge text (default: generic wording)
//   SPIRAL_GUARD_LOG              path for JSONL trigger log (default /tmp/opencode/spiral-guard.jsonl)
//   SPIRAL_GUARD_DEBUG=1          dump the raw shape the hook receives for each tool call
//   SPIRAL_GUARD_DISABLED=1       turn the whole plugin off for one invocation

import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { appendFileSync, chmodSync, mkdirSync, statSync } from "node:fs"
import { dirname } from "node:path"

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Config

const DISABLED = process.env.SPIRAL_GUARD_DISABLED === "1"
const SOFT = Math.max(1, Number(process.env.SPIRAL_GUARD_FAIL_THRESHOLD ?? 2))
const HARD = Math.max(SOFT + 1, Number(process.env.SPIRAL_GUARD_HARD_THRESHOLD ?? 3))
const READ_SPY = Math.max(2, Number(process.env.SPIRAL_GUARD_READ_SPY ?? 3))
const MAX_FIRES = Math.max(1, Number(process.env.SPIRAL_GUARD_MAX_FIRES ?? 2))
const LOG_PATH = process.env.SPIRAL_GUARD_LOG ?? "/tmp/opencode/spiral-guard.jsonl"
const DEBUG = process.env.SPIRAL_GUARD_DEBUG === "1"

// Tools whose failures are NOT signal (network flakiness, expected subagent
// retries, or meta tools that are part of normal flow).
const IGNORED_TOOLS = new Set([
  "task",
  "skill",
  "todowrite",
  "todoread",
  "webfetch",
  "web_search",
])

// ---------------------------------------------------------------------------
// Ladder text. Generic escalation: change the approach first (SOFT), then
// either delegate to a more-suited subagent via the host's delegation
// tooling or stop and diagnose the wrong assumption (HARD). Hosts with
// named subagents set SPIRAL_GUARD_DELEGATE_HINT so the nudge names
// theirs instead of the generic wording.

const DELEGATE_HINT = process.env.SPIRAL_GUARD_DELEGATE_HINT ?? ""

const softText = (target: string) =>
  `[spiral-guard -- SOFT] ${SOFT} consecutive failures on ${target}. ` +
  `Do NOT retry the exact same call. Change approach: re-read the relevant ` +
  `section with Read offset/limit, check a different source, or try a ` +
  `different command. If a specialized subagent fits this step better` +
  (DELEGATE_HINT ? ` (${DELEGATE_HINT})` : "") +
  `, consider delegating instead of a third attempt in this same approach.`

const hardText = (target: string) =>
  `[spiral-guard -- HARD] ${HARD} consecutive failures on ${target}. ` +
  `Stop repeating this approach. Either delegate this step ` +
  (DELEGATE_HINT ? `to ${DELEGATE_HINT}, ` : `to a subagent suited to it, `) +
  `or step back and diagnose why this keeps failing (wrong assumption about ` +
  `the file/command/API?) before any further attempt. Do not attempt a ` +
  `third variant of the same approach.`

// ---------------------------------------------------------------------------
// State, scoped per opencode session (a single opencode process can host
// multiple concurrent sessions -- background tasks, subagents -- so a
// bare per-target map would leak a failure streak from one session into an
// unrelated session's next turn).

interface Pair {
  fails: number
  reads: number
  softFires: number
  hardFired: boolean
  lastError?: string
}

interface SessionState {
  pairs: Map<string, Pair>
  lastSeen: number
}

// Bounded: a single long-lived opencode process can host many sessions
// (subagents, background tasks), and an unbounded Map would retain every
// target string of every session it ever saw for the life of the process.
const MAX_SESSIONS = Math.max(8, Number(process.env.SPIRAL_GUARD_MAX_SESSIONS ?? 64))

const sessions = new Map<string, SessionState>()
let lastToastAt = 0

function evictStaleSessions() {
  if (sessions.size <= MAX_SESSIONS) return
  // Drop least-recently-seen first.
  const byAge = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)
  for (const [id] of byAge.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id)
}

function sessionState(sessionID: string): SessionState {
  let s = sessions.get(sessionID)
  if (!s) {
    s = { pairs: new Map(), lastSeen: Date.now() }
    sessions.set(sessionID, s)
    evictStaleSessions()
  }
  s.lastSeen = Date.now()
  return s
}

function pairFor(state: SessionState, key: string): Pair {
  let p = state.pairs.get(key)
  if (!p) {
    p = { fails: 0, reads: 0, softFires: 0, hardFired: false }
    state.pairs.set(key, p)
  }
  return p
}

// ---------------------------------------------------------------------------
// Logging (best-effort, never throws)

let logDirEnsured = false

function log(kind: string, target: string, extra?: Record<string, unknown>) {
  try {
    // The log directory may not exist yet on a fresh machine
    // (mkdirSync recursive creates it), and this whole function swallows
    // errors by design -- without the permissions repair below, a shared
    // /tmp location would leave a world-readable file (typically 0644
    // after umask).
    //
    // `target`/`extra` can contain shell-command prefixes, file paths, and
    // error text -- any of which may include credentials or other secrets
    // from a failing command. The log directory/file are created with
    // 0700/0600 (owner-only) and an existing file/dir from before this
    // fix is repaired to the same tighter mode on first write this
    // process. Only attempted once per process.
    if (!logDirEnsured) {
      mkdirSync(dirname(LOG_PATH), { recursive: true, mode: 0o700 })
      try {
        chmodSync(dirname(LOG_PATH), 0o700)
      } catch {
        /* best-effort permission repair */
      }
      try {
        if (statSync(LOG_PATH).isFile()) chmodSync(LOG_PATH, 0o600)
      } catch {
        /* file may not exist yet -- appendFileSync below creates it */
      }
      logDirEnsured = true
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      target,
      pid: process.pid,
      ...extra,
    })
    appendFileSync(LOG_PATH, line + "\n", { mode: 0o600 })
  } catch {
    /* never disrupt the session */
  }
}

// ---------------------------------------------------------------------------
// Target extraction: stable, coarse identity per (tool, args)

function targetOf(tool: string, args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>
    switch (tool) {
      case "bash":
      case "shell":
        return `bash: ${String(a.command ?? "").trim().slice(0, 80)}`
      case "edit":
      case "write":
        return `${tool}: ${String(a.path ?? a.filePath ?? "")}`
      case "read":
        return `read: ${String(a.path ?? a.filePath ?? "")}`
      case "glob":
        return `glob: ${String(a.pattern ?? "")} ${String(a.path ?? "")}`.trim()
      case "grep":
        return `grep: ${String(a.pattern ?? "")} ${String(a.include ?? "")}`.trim()
      default: {
        const s = JSON.stringify(a)
        return `${tool}: ${s.slice(0, 80)}`
      }
    }
  }
  return tool
}

// ---------------------------------------------------------------------------
// Toast (WSL/macOS/linux). opencode 2.0's plugin API has no injected shell
// (`$`) anymore, so this shells out via execFile with real argv arrays --
// title/message here are built from tool args (shell commands, file paths),
// which are attacker-influenced if a malicious/compromised command is what
// is failing. Passing them as ARGV elements (never interpolated into a
// script body) is the whole safety story: there is no -e/-Command string
// for a metacharacter to break out of. The one exception is the WSL toast
// XML, which embeds the escaped title/message as XML text and the XML as a
// single-quoted PowerShell string (with ' doubled) -- matching the host
// notify plugin's 2.0 port pattern.

function xmlEscape(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

const WINDOWS_APP_ID = "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"

async function toast(title: string, message: string) {
  const now = Date.now()
  if (now - lastToastAt < 3000) return // de-bounce bursts
  lastToastAt = now
  try {
    const env = process.env
    if (process.platform === "darwin") {
      // `display notification ... with title ...` driven by argv, with the
      // title/message passed as REAL arguments to a fixed osascript program
      // ("on run argv"), never interpolated into the script text itself.
      await execFileAsync("osascript", [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        message,
      ])
    } else if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
      // Only the XML-escaped title/message are embedded in the toast XML
      // document, and the XML itself is embedded in the PowerShell script
      // as a single-quoted string with ' doubled -- the script is otherwise
      // a fixed string. Passed as the single -Command argument, no shell.
      const xml =
        `<toast><visual><binding template="ToastText02">` +
        `<text id="1">${xmlEscape(title)}</text>` +
        `<text id="2">${xmlEscape(message)}</text>` +
        `</binding></visual></toast>`
      const script =
        `$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]; ` +
        `$doc = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime]::new(); ` +
        `$doc.LoadXml('${xml.replace(/'/g, "''")}'); ` +
        `$toast = [Windows.UI.Notifications.ToastNotification]::new($doc); ` +
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${WINDOWS_APP_ID}').Show($toast);`
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script])
    } else if (process.platform === "linux") {
      await execFileAsync("notify-send", [title, message])
    }
  } catch {
    /* notifications are cosmetic; swallow */
  }
}

// ---------------------------------------------------------------------------
// Failure heuristics, derived against the opencode 2.0 tool.execute.after
// event: `{tool, sessionID, input, status: "completed"|"error", result?|error?}`.
// The plugin block at the bottom flattens that event into a Probe with
// `{status?, message?, content?, metadata?}` -- this function only ever
// sees the flat shape, so it stays unit-testable as a pure function.
//
// Priority order, from most trustworthy to least:
//   1. status === "error"                    -- the host itself failed the call
//   2. metadata.error (string or {message})  -- host/tool reports the failure
//   3. metadata.ok === false                 -- explicit false
//   4. metadata.status === "error"           -- explicit status
//   5. metadata.exit  (number, non-zero)     -- shell / CLI exit code
//   6. metadata.stderr (non-empty string)    -- only if exit is also non-zero,
//      or there is no exit code at all. stderr alone is ambiguous (warnings).
//   7. content narrow-text match             -- last resort for shell only,
//      with strict patterns (command-not-found, permission-denied, an
//      explicit non-zero exit-code banner, traceback/segfault/OOM-kill). We
//      deliberately do NOT use loose words like "error"/"failed"/"cannot"/
//      "not found" on the output text: those are legitimately produced
//      by successful commands and their subprocesses' own output.
//
// We never sniff raw output text for non-shell tools: the shape there is
// tool-specific and a loose word scan would produce false positives.
// Anything uncertain is treated as NOT a failure (spiral-guard must be
// conservative -- false negatives are acceptable, false-positive
// escalation toasts are not).

function detectFailure(tool: string, ev: { status?: unknown; message?: unknown; content?: unknown; metadata?: unknown }): string | undefined {
  // 1. The host reports the whole call as failed.
  const status = typeof ev.status === "string" ? ev.status.toLowerCase() : ""
  if (status === "error") {
    const msg = typeof ev.message === "string" ? ev.message.trim() : ""
    if (msg) return msg.slice(0, 200)
    return "status=error"
  }

  // 2-6. Completed call -- but the tool may still report failure in metadata.
  const meta = (ev.metadata ?? {}) as Record<string, unknown>

  if (typeof meta.error === "string" && meta.error.trim()) return meta.error.slice(0, 200)
  if (meta.error && typeof meta.error === "object") {
    const e = meta.error as Record<string, unknown>
    if (typeof e.message === "string" && e.message.trim()) return e.message.slice(0, 200)
  }

  if (meta.ok === false) return "ok=false"

  if (meta.status != null && String(meta.status).toLowerCase() === "error") return "status=error"

  const hasExit = typeof meta.exit !== "undefined" && meta.exit !== null && !Number.isNaN(Number(meta.exit))
  if (hasExit && Number(meta.exit) !== 0) return `exit=${meta.exit}`

  const stderr = typeof meta.stderr === "string" ? meta.stderr : undefined
  if (stderr && stderr.trim()) {
    if (!hasExit) return `stderr: ${stderr.slice(0, 120)}`
    if (hasExit && Number(meta.exit) !== 0) return `exit+stderr: ${stderr.slice(0, 120)}`
  }

  // 7. Narrow terminal-text patterns, shell only. The 2.0 shell tool's
  // visible output is `result.content` -- either a plain string or a
  // readonly array of {type:"text"|"file"} parts; textOf flattens both.
  if (tool === "shell" || tool === "bash") {
    const s = textOf(ev.content)
    if (s) {
      const narrow = [
        /\bcommand not found\b/i,
        /\bpermission denied\b/i,
        /\bexit code\s+(?!0\b)\d+\b/i, // "exit code 1", "exit code 127" -- any non-zero, incl. single digit
        /Traceback \(most recent call last\)/,
        /\bSegmentation fault\b/i,
        /\bKilled\b.*out of memory/i,
      ]
      for (const re of narrow) {
        if (re.test(s)) return `text: ${(s.match(re) ?? [s])[0].slice(0, 160)}`
      }
    }
  }

  return undefined
}

// Flatten a 2.0 Tool.Result.content (string | readonly Content[]) into the
// text the model actually reads. Unknown shapes yield "" (no sniff).
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    // No type annotation on `parts`: the test harness extracts this
    // function and strips TS syntax with regexes that do not cover
    // variable annotations.
    const parts = []
    for (const c of content) {
      if (c && typeof c === "object") {
        const p = c as Record<string, unknown>
        if (p.type === "text" && typeof p.text === "string") parts.push(p.text)
      }
    }
    return parts.join("\n")
  }
  return ""
}

function probeShape(tool: string, ev: { status?: unknown; message?: unknown; content?: unknown; metadata?: unknown }): void {
  try {
    const meta = (ev.metadata ?? {}) as Record<string, unknown>
    const shape = {
      tool,
      status: ev.status,
      contentType: Array.isArray(ev.content) ? "array" : typeof ev.content,
      metaKeys: meta && typeof meta === "object" ? Object.keys(meta) : [typeof ev.metadata],
      metaError: typeof meta.error === "string" ? meta.error : undefined,
      metaExit: typeof meta.exit === "number" ? meta.exit : undefined,
      metaOk: typeof meta.ok === "boolean" ? meta.ok : undefined,
      metaStatus: meta.status != null ? meta.status : undefined,
      stderrLen: typeof meta.stderr === "string" ? meta.stderr.length : undefined,
    }
    log("shape", tool, shape)
  } catch {
    /* never break the call path on debug */
  }
}

// ---------------------------------------------------------------------------
// Trigger logic. Returns the nudge text to append to THIS tool's output, or
// undefined. Returning it (rather than stashing it for a later hook) is what
// makes the nudge land in the right conversation at the right moment -- see
// the plugin block at the bottom for why the previous approach could not.

function evaluate(
  sessionID: string,
  tool: string,
  args: unknown,
  ev: { status?: unknown; message?: unknown; content?: unknown; metadata?: unknown },
): string | undefined {
  if (DISABLED || IGNORED_TOOLS.has(tool)) return
  if (DEBUG) probeShape(tool, ev)

  const state = sessionState(sessionID)
  const target = targetOf(tool, args)
  const p = pairFor(state, target)
  const isError = detectFailure(tool, ev)

  // Read-spy: reads of one file piling up with no interleaved write.
  if (tool === "read") {
    p.reads += 1
    if (p.reads === READ_SPY) {
      const msg = `Read-spy: ${READ_SPY} reads of ${target} without a write. Are you about to loop?`
      toast("spiral-guard", msg).catch(() => {})
      log("read-spy", target, { sessionID })
      p.reads = 0 // arm again later if it keeps happening; no injection
    }
  }

  // A successful non-read tool call resets the failure streak for this target
  // (deliberately NOT the read counter -- read-spy tracks a different smell).
  if (!isError && tool !== "read") {
    if (p.fails > 0) log("fail-streak-reset", target, { sessionID, streak: p.fails })
    p.fails = 0
  }

  // A successful edit/write to a file IS the write read-spy is waiting for,
  // but edit/write and read use different target keys ("edit: <path>" /
  // "write: <path>" vs "read: <path>"), so it lands in a different Pair.
  // Without this, three reads of a file separated by a successful write to
  // that same file would still fire the read-spy warning, since nothing
  // ever touched the read pair's counter. Reset the read pair explicitly.
  // Both arg spellings accepted: 2.0 tools pass `path`, 1.x passed `filePath`.
  if (!isError && (tool === "edit" || tool === "write")) {
    const a = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined
    const filePath = a ? String(a.path ?? a.filePath ?? "") : ""
    if (filePath) {
      const readTarget = `read: ${filePath}`
      const readPair = state.pairs.get(readTarget)
      if (readPair && readPair.reads > 0) readPair.reads = 0
    }
  }

  if (!isError) return

  p.fails += 1
  p.lastError = isError
  log("failure", target, { sessionID, streak: p.fails, error: p.lastError })

  // HARD and SOFT have independent caps: the SOFT cap cannot swallow the
  // HARD escalation (HARD is the one you most want when truly stuck).
  if (p.fails >= HARD && !p.hardFired) {
    p.hardFired = true
    toast("spiral-guard", `Escalate now: ${target}`).catch(() => {})
    const text = hardText(target)
    log("HARD", target, { sessionID, text })
    return text
  }
  if (p.fails === SOFT && p.softFires < MAX_FIRES) {
    p.softFires += 1
    toast("spiral-guard", `Change approach: ${target}`).catch(() => {})
    const text = softText(target)
    log("SOFT", target, { sessionID, text })
    return text
  }
  return
}

// ---------------------------------------------------------------------------
// Delivery: append the directive to the FAILING TOOL'S OWN OUTPUT.
//
// The 2.0 execute.after event hands us the mutable `result` of a completed
// call, and mutating `result.content` is how a plugin alters a tool result
// -- strictly better than the synthetic-message injection this plugin used
// until 2026-09-12 (on the 1.x message transform hook), which was broken
// in three independent ways:
//
//   1. WRONG POSITION. It did `messages.unshift(...)`, placing the nudge at
//      index 0 -- the OLDEST message, ahead of the original user turn. The
//      model read it as ancient context rather than a live directive. The
//      trigger log proves it never worked: a HARD nudge fired at
//      2026-09-12T00:24:06 and the same command then failed at streaks
//      4, 5, 6, 7 and 8 with no change in approach.
//   2. WRONG (OR NO) SESSION. The 1.x transform hook received no sessionID
//      at all, so the old code guessed via a module-global "last active
//      session", and one opencode process demonstrably interleaves several
//      sessions within seconds, so a nudge could surface in an unrelated
//      conversation.
//   3. RISK OF CORRUPTING THE REQUEST. Inserting a synthetic `user` message
//      into an arbitrary position of a provider-bound history can break
//      strict role-alternation and tool_call/tool_result pairing. Anthropic
//      in particular rejects malformed sequences with errors like
//      `messages: text content blocks must contain non-empty text`.
//
// Appending to the tool result avoids all three: it is inherently scoped to
// the correct session (we are inside that session's tool call), it lands
// exactly where the model is already reading, at the moment of failure, and
// it changes only the text of a tool result -- a shape every provider
// already accepts.
//
// Calls the host reports with status "error" carry no `result` to append to,
// so those streaks escalate via toast only -- the streak still counts
// toward SOFT/HARD, and the trigger logs above record what was said.

const NUDGE_SEPARATOR = "\n\n---\n"

function appendNudge(result: unknown, nudge: string): boolean {
  if (!result || typeof result !== "object") return false
  const r = result as { content?: unknown }
  const c = r.content
  if (typeof c === "string") {
    r.content = `${c}${NUDGE_SEPARATOR}${nudge}`
    return true
  }
  if (Array.isArray(c)) {
    // `content` is typed readonly on Tool.Result, but the event object is
    // a plain mutable object at runtime -- assign a NEW array rather than
    // mutating the old one, so the readonly contract is honored where it
    // can be.
    r.content = [...c, { type: "text", text: nudge }]
    return true
  }
  // No content at all: the nudge alone becomes it.
  r.content = nudge
  return true
}

// 2.0 port: envelope + hook names verified against @opencode/plugin's tool
// domain -- ctx.tool.hook("execute.after") receives
// `{tool, sessionID, input, status: "completed"|"error", result|error}`;
// Tool.Result is `{output?, content?: string | readonly Content[], metadata?}`
// and Tool.Error is a host Error carrying `message` (+ optional
// `error`/`metadata`).
export default Plugin.define({
  id: "spiral-guard",
  async setup(ctx) {
    if (DISABLED) return

    const registration = await ctx.tool.hook("execute.after", (event) => {
      const tool = event?.tool ?? "unknown"
      try {
        const ev = event as
          | {
              readonly tool: string
              readonly sessionID: string
              readonly input: unknown
              readonly status: "completed"
              result: { output?: unknown; content?: unknown; metadata?: unknown }
            }
          | {
              readonly tool: string
              readonly sessionID: string
              readonly input: unknown
              readonly status: "error"
              error: { message?: unknown; error?: unknown; metadata?: unknown }
            }
          | undefined
        if (!ev || !ev.sessionID) return

        // Flat snapshot the pure functions above work against; unknown
        // statuses degrade to "not a failure".
        const probe =
          ev.status === "completed"
            ? {
                status: ev.status,
                message: undefined,
                content: ev.result?.content,
                metadata: ev.result?.metadata,
              }
            : ev.status === "error"
              ? {
                  status: ev.status,
                  message: typeof ev.error?.message === "string" ? ev.error.message : undefined,
                  content: undefined,
                  metadata: ev.error?.metadata,
                }
              : { status: undefined, message: undefined, content: undefined, metadata: undefined }

        const nudge = evaluate(ev.sessionID, ev.tool, ev.input, probe)
        if (nudge) {
          if (ev.status === "completed" && ev.result) {
            const ok = appendNudge(ev.result, nudge)
            log(ok ? "injected" : "inject-failed", targetOf(ev.tool, ev.input), {
              sessionID: ev.sessionID,
              text: nudge,
            })
          } else {
            // status "error": no result to carry the nudge; the toast and
            // SOFT/HARD trigger logs above already record the escalation.
            log("injected-skipped-error-result", targetOf(ev.tool, ev.input), {
              sessionID: ev.sessionID,
              text: nudge,
            })
          }
        }
      } catch (err) {
        log("hook-crash", tool, { sessionID: (event as { sessionID?: string })?.sessionID, error: String(err) })
      }
    })
    return () => registration.dispose()
  },
})
