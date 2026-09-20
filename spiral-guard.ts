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
// opencode's real plugin API and delivery here.
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

import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, chmodSync, mkdirSync, statSync } from "node:fs"
import { dirname } from "node:path"

type Shell = Parameters<Plugin>[0]["$"]

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
    // Bun.file().append() does not create missing parent directories (e.g.
    // the default /tmp/opencode/ on a machine where nothing else has
    // created it yet), and this whole function swallows errors by design
    // -- so without this, a fresh machine would silently never log
    // anything with zero indication why. Only attempted once per process.
    //
    // `target`/`extra` can contain shell-command prefixes, file paths, and
    // error text -- any of which may include credentials or other secrets
    // from a failing command. The log directory/file are created with
    // 0700/0600 (owner-only) rather than the shared /tmp default (typically
    // 0755/0644 after umask, world-readable), and an existing file/dir from
    // before this fix is repaired to the same tighter mode on first write
    // this process.
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
    // Bun.file().write() TRUNCATES the file on every call, and (as of Bun
    // 1.4.0) BunFile has no .append() method at all -- confirmed directly
    // (typeof Bun.file(...).append is "undefined", calling it throws
    // TypeError). node:fs's appendFileSync is the real, verified-working
    // primitive for a growing JSONL log; sync is fine here since logging is
    // low-frequency, best-effort, and already wrapped in this try/catch.
    // `mode: 0o600` only takes effect the first time appendFileSync CREATES
    // the file; the statSync/chmodSync above repairs a pre-existing file
    // from before this fix.
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
        return `bash: ${String(a.command ?? "").trim().slice(0, 80)}`
      case "edit":
      case "write":
        return `${tool}: ${String(a.filePath ?? "")}`
      case "read":
        return `read: ${String(a.filePath ?? "")}`
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
// Toast (WSL/macOS/linux) -- mirrors notify.ts's platform detection, but
// title/message here are built from tool args (bash commands, file paths),
// which are attacker-influenced if a malicious/compromised command is what
// is failing. Every platform branch below passes title/message as real
// shell-quoted arguments (Bun's `$` template tagging), NOT string-interpolated
// into an -e/-Command script body -- unlike the original draft, which built
// an `osascript -e "<interpolated>"` string and a PowerShell -Command string
// by hand, both of which only escaped backslash/quote and could still be
// broken out of by other AppleScript/PowerShell metacharacters in a
// sufficiently adversarial failing command.

function xmlEscape(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

async function toast($: Shell, title: string, message: string) {
  const now = Date.now()
  if (now - lastToastAt < 3000) return // de-bounce bursts
  lastToastAt = now
  try {
    const env = process.env
    if (process.platform === "darwin") {
      // `display notification ... with title ...` as *arguments* to a fixed
      // osascript expression, not interpolated into the -e string itself.
      await $`osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' ${title} ${message}`
        .quiet()
        .nothrow()
    } else if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
      // Only the XML-escaped title/message are embedded in the toast XML
      // document; the PowerShell script body itself is a fixed string with
      // no untrusted interpolation, and the XML is passed as a real
      // argument to -Command's script text via a separate -EncodedCommand-
      // free arg boundary (Bun's `$` still quotes this whole invocation).
      const xml =
        `<toast><visual><binding template="ToastText02">` +
        `<text id="1">${xmlEscape(title)}</text>` +
        `<text id="2">${xmlEscape(message)}</text>` +
        `</binding></visual></toast>`
      const script =
        `param($xml) ` +
        `$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]; ` +
        `$doc = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime]::new(); ` +
        `$doc.LoadXml($xml); ` +
        `$toast = [Windows.UI.Notifications.ToastNotification]::new($doc); ` +
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.WindowsTerminal_8wekyb3d8bbwe!App').Show($toast);`
      await $`powershell.exe -NoProfile -Command ${script} -xml ${xml}`.quiet().nothrow()
    } else if (process.platform === "linux") {
      await $`notify-send ${title} ${message}`.quiet().nothrow()
    }
  } catch {
    /* notifications are cosmetic; swallow */
  }
}

// ---------------------------------------------------------------------------
// Failure heuristics. tool.execute.after does not give us an explicit error
// flag, so we sniff common failure shapes defensively. Anything uncertain is
// treated as NOT a failure (spiral-guard must be conservative -- false negatives
// are acceptable, false-positive escalation toasts are not).
//
// Priority order, from most trustworthy to least:
//   1. metadata.error (string or {message})  -- plugin/host reports the failure
//   2. metadata.ok === false                 -- explicit false
//   3. metadata.status === "error"           -- explicit status
//   4. metadata.exit  (number, non-zero)     -- bash / CLI exit code
//   5. metadata.stderr (non-empty string)    -- only if exit is also non-zero,
//      or there is no exit code at all. stderr alone is ambiguous (warnings).
//   6. output.output narrow-text match       -- last resort for bash only,
//      with strict patterns (command-not-found, permission-denied, an
//      explicit non-zero exit-code banner, traceback/segfault/OOM-kill). We
//      deliberately do NOT use loose words like "error"/"failed"/"cannot"/
//      "not found" on the terminal stream: those are legitimately produced
//      by successful commands and their subprocesses' own output.
//
// We never sniff raw `output.output` for non-bash tools: the shape there is
// tool-specific and a loose word scan would produce false positives.

function detectFailure(tool: string, out: { title?: string; output?: string; metadata?: unknown }): string | undefined {
  const meta = (out.metadata ?? {}) as Record<string, unknown>

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

  if (tool === "bash" && typeof out.output === "string" && out.output) {
    const s = out.output
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

  return undefined
}

function probeShape(tool: string, output: { title?: string; output?: string; metadata?: unknown }): void {
  try {
    const shape = {
      tool,
      outKeys: output && typeof output === "object" ? Object.keys(output) : [typeof output],
      outType: typeof output?.output,
      metaKeys: output?.metadata && typeof output?.metadata === "object"
        ? Object.keys(output.metadata as Record<string, unknown>)
        : [typeof output?.metadata],
      metaError: output?.metadata && typeof (output.metadata as Record<string, unknown>)?.error === "string"
        ? (output.metadata as Record<string, unknown>).error
        : undefined,
      metaExit: output?.metadata && typeof (output.metadata as Record<string, unknown>)?.exit === "number"
        ? (output.metadata as Record<string, unknown>).exit
        : undefined,
      metaOk: output?.metadata && typeof (output.metadata as Record<string, unknown>)?.ok === "boolean"
        ? (output.metadata as Record<string, unknown>).ok
        : undefined,
      metaStatus: output?.metadata && (output.metadata as Record<string, unknown>)?.status != null
        ? (output.metadata as Record<string, unknown>).status
        : undefined,
      stderrLen: typeof (output?.metadata as Record<string, unknown>)?.stderr === "string"
        ? ((output?.metadata as Record<string, unknown>).stderr as string).length
        : undefined,
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
  $: Shell,
  sessionID: string,
  tool: string,
  args: unknown,
  output: { title?: string; output?: string; metadata?: unknown },
): string | undefined {
  if (DISABLED || IGNORED_TOOLS.has(tool)) return
  if (DEBUG) probeShape(tool, output)

  const state = sessionState(sessionID)
  const target = targetOf(tool, args)
  const p = pairFor(state, target)
  const isError = detectFailure(tool, output ?? {})

  // Read-spy: reads of one file piling up with no interleaved write.
  if (tool === "read") {
    p.reads += 1
    if (p.reads === READ_SPY) {
      const msg = `Read-spy: ${READ_SPY} reads of ${target} without a write. Are you about to loop?`
      toast($, "spiral-guard", msg).catch(() => {})
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
  if (!isError && (tool === "edit" || tool === "write")) {
    const a = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined
    const filePath = a ? String(a.filePath ?? "") : ""
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
    toast($, "spiral-guard -- HARD", `Escalate now: ${target}`).catch(() => {})
    const text = hardText(target)
    log("HARD", target, { sessionID, text })
    return text
  }
  if (p.fails === SOFT && p.softFires < MAX_FIRES) {
    p.softFires += 1
    toast($, "spiral-guard -- SOFT", `Change approach: ${target}`).catch(() => {})
    const text = softText(target)
    log("SOFT", target, { sessionID, text })
    return text
  }
  return
}

// ---------------------------------------------------------------------------
// Delivery: append the directive to the FAILING TOOL'S OWN OUTPUT.
//
// `tool.execute.after` hands us a mutable `output` and returns void, so
// mutating `output.output` is the API's intended way for a plugin to alter a
// tool result -- and it is strictly better than the synthetic-message
// injection this plugin used until 2026-09-12, which was broken in three
// independent ways:
//
//   1. WRONG POSITION. It did `messages.unshift(...)`, placing the nudge at
//      index 0 -- the OLDEST message, ahead of the original user turn. The
//      model read it as ancient context rather than a live directive. The
//      trigger log proves it never worked: a HARD nudge fired at
//      2026-09-12T00:24:06 and the same command then failed at streaks
//      4, 5, 6, 7 and 8 with no change in approach.
//   2. WRONG (OR NO) SESSION. `experimental.chat.messages.transform` receives
//      `input: {}` -- verified against @opencode-ai/plugin's own types, there
//      is no sessionID field at all. The old code guessed via a module-global
//      "last active session", and one opencode process demonstrably
//      interleaves several sessions within seconds (pid 1166204 served three
//      in ~90s on 2026-09-12), so a nudge could surface in an unrelated
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

const NUDGE_SEPARATOR = "\n\n---\n"

export const SpiralGuardPlugin: Plugin = async ({ $ }) => {
  if (DISABLED) return {}

  return {
    "tool.execute.after": async (input, output) => {
      try {
        const nudge = evaluate($, input.sessionID, input.tool, input.args, output ?? {})
        if (nudge && output) {
          output.output = `${output.output ?? ""}${NUDGE_SEPARATOR}${nudge}`
          log("injected", targetOf(input.tool, input.args), { sessionID: input.sessionID, text: nudge })
        }
      } catch (err) {
        log("hook-crash", input.tool, { sessionID: input.sessionID, error: String(err) })
      }
    },
  }
}

export default SpiralGuardPlugin
