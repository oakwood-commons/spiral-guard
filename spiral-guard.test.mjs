// Unit tests for spiral-guard's pure functions: failure detection, target
// extraction, output-text flattening, and toast XML escaping. Harness
// technique: extract named declarations from the real .ts source, strip
// TS-only syntax, evaluate in a shared closure. Run with:
// node --test spiral-guard.test.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { formatSummary, summarizeLog } from "./scripts/summarize-log.mjs"

const src = readFileSync(new URL("./spiral-guard.ts", import.meta.url), "utf8")

function extract(name) {
  // SAFELIST first (SAST hardening): this helper interpolates `name` into a
  // RegExp, so it must reject anything that is not a plain JS identifier --
  // the tests only ever pass literal identifiers from the names array, but
  // the invariant is documented and enforced here rather than assumed.
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`invalid extract name: ${name}`)
  // Match `const NAME = ...` or `function NAME(...) {...}` up to the next
  // top-level declaration or `// ---` separator line. No bare `\n$`
  // alternative: with the "m" flag that matches every INTERNAL blank line,
  // truncating the chunk mid-function.
  const re = new RegExp(
    `^(?:const|function)\\s+${name}\\b[\\s\\S]*?(?=\\n(?:const|let|function|async\\s+function|interface|export|//\\s*---))`,
    "m",
  )
  const m = re.exec(src)
  if (!m) throw new Error(`could not extract "${name}" from spiral-guard.ts -- was it renamed?`)
  return m[0]
}

function detype(code) {
  const TYPE = String.raw`(?:string|number|boolean|unknown|void|SessionState|Pair)(?:\[\])?`
  return (
    code
      // `as` type casts -> drop (`args as Record<string, unknown>` -> `args`)
      .replace(/\bas\s+[A-Za-z_$][\w$|.\[\]<> ,]*(?=[=;)\n]|$)/g, "")
      // inline-object param type: `ev: { status?: ...; ... })` -> `ev)`
      .replace(/(\w+)\s*:\s*\{[^{}]*\}\s*(?=\))/g, "$1")
      // `): string | undefined {` -> `) {`
      .replace(/\)\s*:\s*string\s*\|\s*undefined\s*\{/g, ") {")
      // `): string {` -> `) {`
      .replace(new RegExp(String.raw`\)\s*:\s*${TYPE}\s*\{`, "g"), ") {")
      // bare param annotations: `(tool: string, ev)` -> `(tool, ev)`
      .replace(new RegExp(String.raw`(\(|,\s*)(\w+)\s*:\s*${TYPE}`, "g"), "$1$2")
  )
}

const names = [
  "IGNORED_TOOLS",
  "NUDGE_SEPARATOR",
  "targetOf",
  "detectFailure",
  "textOf",
  "xmlEscape",
  "appendNudge",
  "appendErrorNudge",
]
const body = names.map((n) => detype(extract(n))).join("\n")
const { targetOf, detectFailure, textOf, xmlEscape, IGNORED_TOOLS, NUDGE_SEPARATOR, appendNudge, appendErrorNudge } =
  new Function(
    body +
      "\nreturn { targetOf, detectFailure, textOf, xmlEscape, IGNORED_TOOLS, NUDGE_SEPARATOR, appendNudge, appendErrorNudge }",
  )()

test("targetOf: stable coarse identity per tool shape", () => {
  const t = targetOf("bash", { command: "ls -la /very/long/path/that/gets/truncated", workdir: "/x" })
  if (!t.startsWith("bash: ls -la /very/long")) throw new Error("bash prefix wrong: " + t)
  if (t.length > 80 + "bash: ".length + 5) throw new Error("bash target not truncated: " + t)
  const r = targetOf("read", { filePath: "/a/b.go", offset: 1 })
  if (r !== "read: /a/b.go") throw new Error("read target wrong: " + r)
  const e = targetOf("edit", { filePath: "/c", oldString: "x", newString: "y" })
  if (e !== "edit: /c") throw new Error("edit target wrong: " + e)
  const g = targetOf("grep", { pattern: "foo.*bar", include: "*.ts" })
  if (g !== "grep: foo.*bar *.ts") throw new Error("grep target wrong: " + g)
  const d = targetOf("task", { prompt: "do things" })
  if (!d.startsWith("task: ")) throw new Error("default shape wrong: " + d)
  if (targetOf("task", "not-an-object-shape") !== "task") throw new Error("bare-args fallback wrong")
})

test("targetOf: 2.0 tool spellings (shell, path arg)", () => {
  const s = targetOf("shell", { command: "npm test", workdir: "/x" })
  if (s !== "bash: npm test") throw new Error("shell target wrong: " + s)
  const r = targetOf("read", { path: "/v2/path.go", offset: 1 })
  if (r !== "read: /v2/path.go") throw new Error("read path-arg target wrong: " + r)
  const w = targetOf("write", { path: "/new", content: "x" })
  if (w !== "write: /new") throw new Error("write path-arg target wrong: " + w)
})

test("detectFailure: host status=error is the most-trusted signal", () => {
  if (detectFailure("shell", { status: "error", message: "provider 400: boom" }) !== "provider 400: boom")
    throw new Error("status error + message missed")
  if (detectFailure("shell", { status: "error" }) !== "status=error")
    throw new Error("status error without message missed")
  // status ok -> not a failure on its own
  if (detectFailure("shell", { status: "completed" }) !== undefined)
    throw new Error("completed status false positive")
  // unknown/missing status degrades to metadata heuristics, not failure
  if (detectFailure("shell", {}) !== undefined) throw new Error("empty event false positive")
})

test("detectFailure: metadata shapes, most-trusted first", () => {
  if (detectFailure("shell", { metadata: { error: "boom" } }) !== "boom") throw new Error("meta.error string missed")
  if (detectFailure("shell", { metadata: { error: { message: "wrapped" } } }) !== "wrapped") throw new Error("meta.error.message missed")
  if (detectFailure("shell", { metadata: { ok: false } }) !== "ok=false") throw new Error("ok:false missed")
  if (detectFailure("shell", { metadata: { status: "error" } }) !== "status=error") throw new Error("status:error missed")
  if (detectFailure("shell", { metadata: { exit: 127 } }) !== "exit=127") throw new Error("non-zero exit missed")
  if (detectFailure("shell", { metadata: { exit: 0 } }) !== undefined) throw new Error("zero exit false positive")
  // status=error wins over metadata that claims success
  if (detectFailure("shell", { status: "error", message: "host failed", metadata: { exit: 0 } }) !== "host failed")
    throw new Error("status precedence over metadata wrong")
})

test("detectFailure: stderr handling is conservative", () => {
  // stderr with no exit code at all -> counts (nothing else to judge by)
  if (!String(detectFailure("shell", { metadata: { stderr: "fatal: no such file" } })).startsWith("stderr:"))
    throw new Error("stderr-only missed")
  // stderr WITH zero exit -> warnings are not failures
  if (detectFailure("shell", { metadata: { exit: 0, stderr: "deprecation warning" } }) !== undefined)
    throw new Error("exit 0 + stderr false positive")
  // stderr with non-zero exit -> the EXIT rule fires first (plain exit=N);
  // the exit+stderr branch only applies when exit is 0 -- and 0+stderr is
  // deliberately NOT a failure (warnings are not errors).
  if (detectFailure("shell", { metadata: { exit: 2, stderr: "usage" } }) !== "exit=2")
    throw new Error("exit precedence over stderr wrong")
})

test("detectFailure: narrow terminal-text patterns, shell only (2.0 content field)", () => {
  const hit = (content) => detectFailure("shell", { status: "completed", content })
  if (!String(hit("sh: foo: command not found")).includes("command not found")) throw new Error("cnf missed")
  if (!String(hit("bash: line 1: cd: /x: Permission denied")).includes("Permission denied")) throw new Error("perm missed")
  if (!String(hit("Exit code 1")).startsWith("text:")) throw new Error("exit-code banner missed")
  if (hit("Exit code 0") !== undefined) throw new Error("exit 0 banner false positive")
  if (!String(hit("Traceback (most recent call last):")).includes("Traceback")) throw new Error("traceback missed")
  if (!String(hit("Segmentation fault (core dumped)")).includes("Segmentation")) throw new Error("segfault missed")
  // loose words must NOT count as failures
  if (hit("npm WARN deprecated something-or-other") !== undefined) throw new Error("loose-word false positive")
  if (hit("0 errors, 0 warnings") !== undefined) throw new Error("loose-word false positive 2")
  // non-shell tools never sniff raw output -- the old tool name AND the 2.0
  // read tool are both exempt from the text scan
  if (detectFailure("edit", { status: "completed", content: "command not found" }) !== undefined)
    throw new Error("non-bash text sniff")
  if (detectFailure("read", { status: "completed", content: "Exit code 1" }) !== undefined)
    throw new Error("read text sniff")
})

test("textOf: flattens 2.0 content shapes", () => {
  if (textOf("plain string") !== "plain string") throw new Error("string content wrong")
  if (textOf([{ type: "text", text: "one" }, { type: "text", text: "two" }]) !== "one\ntwo")
    throw new Error("array-of-text content wrong: " + textOf([{ type: "text", text: "one" }, { type: "text", text: "two" }]))
  // file parts and unknown shapes contribute nothing / yield empty
  if (textOf([{ type: "file", uri: "file:///x", mime: "text/plain" }]) !== "")
    throw new Error("file part should be skipped")
  if (textOf(undefined) !== "") throw new Error("undefined content wrong")
  if (textOf(42) !== "") throw new Error("number content wrong")
  // detectFailure accepts the array form too (flattened via textOf)
  if (!String(detectFailure("shell", { status: "completed", content: [{ type: "file", uri: "file:///x", mime: "text/plain" }, { type: "text", text: "Exit code 1" }] })).startsWith("text:"))
    throw new Error("array content text sniff missed")
})

test("detectFailure: clean results and empty metadata are not failures", () => {
  if (detectFailure("shell", { status: "completed", content: "all good" }) !== undefined)
    throw new Error("clean false positive")
  if (detectFailure("read", { status: "completed" }) !== undefined) throw new Error("empty content false positive")
  if (detectFailure("read", { status: "completed", metadata: {} }) !== undefined)
    throw new Error("empty-obj meta false positive")
})

test("xmlEscape: every XML metacharacter is escaped", () => {
  const out = xmlEscape(`a&b<c>d"e'f`)
  if (out !== "a&amp;b&lt;c&gt;d&quot;e&apos;f") throw new Error("xmlEscape wrong: " + out)
})

test("IGNORED_TOOLS: meta/flaky tools are listed", () => {
  for (const t of ["task", "skill", "todowrite", "todoread", "webfetch", "web_search"]) {
    if (!IGNORED_TOOLS.has(t)) throw new Error(t + " missing from IGNORED_TOOLS")
  }
})

// ---------------------------------------------------------------------------
// Env contract: the config block reads SPIRAL_GUARD_* at module scope. These
// tests rebuild the closure under controlled process.env so a renamed/dead
// env var or a broken clamp fails loudly instead of silently restoring
// defaults (the watchdog->spiral-guard rename means any reverted env name
// in a shell rc silently restores defaults -- pinned the same way here as
// in the source config repo).

function buildConfig(envPatch) {
  // `undefined` = ensure the var is UNSET (empty string is NOT unset: `??` is
  // nullish-coalescing and "" flows into Number() as 0).
  const names = ["DISABLED", "SOFT", "HARD", "READ_SPY", "MAX_FIRES", "LOG_PATH", "DEBUG", "DELEGATE_HINT"]
  const re = new RegExp(`^const\\s+(?:${names.join("|")})\\b[\\s\\S]*?(?=\\nconst|\\nfunction|\\n//\\s*---)`, "gm")
  const body = src.match(re).join("\n")
  const saved = {}
  for (const [k, v] of Object.entries(envPatch)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return new Function(body + "\nreturn { DISABLED, SOFT, HARD, READ_SPY, MAX_FIRES, LOG_PATH, DEBUG, DELEGATE_HINT }")()
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

test("env defaults with everything unset", () => {
  const c = buildConfig({
    SPIRAL_GUARD_DISABLED: undefined,
    SPIRAL_GUARD_FAIL_THRESHOLD: undefined,
    SPIRAL_GUARD_HARD_THRESHOLD: undefined,
    SPIRAL_GUARD_READ_SPY: undefined,
    SPIRAL_GUARD_MAX_FIRES: undefined,
    SPIRAL_GUARD_DELEGATE_HINT: undefined,
  })
  if (c.SOFT !== 2) throw new Error("SOFT default: " + c.SOFT)
  if (c.HARD !== 3) throw new Error("HARD default: " + c.HARD)
  if (c.READ_SPY !== 3) throw new Error("READ_SPY default: " + c.READ_SPY)
  if (c.MAX_FIRES !== 2) throw new Error("MAX_FIRES default: " + c.MAX_FIRES)
  if (c.DELEGATE_HINT !== "") throw new Error("DELEGATE_HINT default not empty")
  if (c.DISABLED !== false) throw new Error("DISABLED default")
  if (c.LOG_PATH.indexOf("spiral-guard") === -1) throw new Error("LOG_PATH lost name: " + c.LOG_PATH)
})

test("env overrides + clamps", () => {
  const c = buildConfig({
    SPIRAL_GUARD_FAIL_THRESHOLD: "5",
    SPIRAL_GUARD_HARD_THRESHOLD: "4", // below SOFT+1 -> clamps
    SPIRAL_GUARD_READ_SPY: "1", // below floor 2 -> clamps
    SPIRAL_GUARD_MAX_FIRES: "7",
    SPIRAL_GUARD_DELEGATE_HINT: "my cheap subagent",
  })
  if (c.SOFT !== 5) throw new Error("SOFT override: " + c.SOFT)
  if (c.HARD !== 6) throw new Error("HARD must clamp to SOFT+1: " + c.HARD)
  if (c.READ_SPY !== 2) throw new Error("READ_SPY clamp: " + c.READ_SPY)
  if (c.MAX_FIRES !== 7) throw new Error("MAX_FIRES override: " + c.MAX_FIRES)
  if (c.DELEGATE_HINT !== "my cheap subagent") throw new Error("hint override: " + c.DELEGATE_HINT)

  const disabledSpy = buildConfig({ SPIRAL_GUARD_READ_SPY: "0" })
  if (disabledSpy.READ_SPY !== 0) throw new Error("SPIRAL_GUARD_READ_SPY=0 must disable (0), got: " + disabledSpy.READ_SPY)
})

test("targetOf: strips leading cd/export preambles and normalizes whitespace", () => {
  const longDir = "/Users/dev/worktrees/project-name/fix-12345-some-very-long-branch-slug-that-exceeds-eighty-chars"
  const t1 = targetOf("bash", { command: `cd ${longDir} && npm test` })
  const t2 = targetOf("bash", { command: `cd ${longDir} && git status` })
  if (t1 !== "bash: npm test") throw new Error("cd && preamble not stripped: " + t1)
  if (t2 !== "bash: git status") throw new Error("cd && preamble collision: " + t2)

  const quoted = targetOf("shell", { command: `cd "${longDir}/sub && dir"; export FOO="a b" BAR=1 && pytest -q` })
  if (quoted !== "bash: pytest -q") throw new Error("chained/quoted preamble not stripped: " + quoted)

  const ws = targetOf("bash", { command: "  npm   run   lint \n  --fix  " })
  if (ws !== "bash: npm run lint --fix") throw new Error("whitespace normalization wrong: " + ws)

  // Fallback when the entire command is just cd or export
  const bareCd = targetOf("bash", { command: "cd /some/dir" })
  if (bareCd !== "bash: cd /some/dir") throw new Error("bare cd fallback wrong: " + bareCd)
  const bareExport = targetOf("bash", { command: "export FOO=bar" })
  if (bareExport !== "bash: export FOO=bar") throw new Error("bare export fallback wrong: " + bareExport)
})

test("appendNudge: mutates string, array, and empty result.content safely", () => {
  const rStr = { content: "original output" }
  if (!appendNudge(rStr, "nudge-1")) throw new Error("appendNudge string failed")
  if (rStr.content !== `original output${NUDGE_SEPARATOR}nudge-1`) throw new Error("bad string content: " + rStr.content)

  const origArr = [{ type: "text", text: "part1" }]
  const rArr = { content: origArr }
  if (!appendNudge(rArr, "nudge-2")) throw new Error("appendNudge array failed")
  if (rArr.content === origArr) throw new Error("appendNudge mutated array in place instead of replacing")
  if (rArr.content.length !== 2 || rArr.content[1].text !== "nudge-2") throw new Error("bad array content")

  const rEmpty = {}
  if (!appendNudge(rEmpty, "nudge-3") || rEmpty.content !== "nudge-3") throw new Error("appendNudge empty failed")

  if (appendNudge(null, "x") !== false) throw new Error("null result should return false")
  if (appendNudge(Object.freeze({ content: "frozen" }), "x") !== false) throw new Error("frozen result should return false")
})

test("appendErrorNudge: reconstructs Tool.Error, mutates plain/Error, and handles frozen/empty safely", () => {
  const plainArgsSym = Symbol.for("effect/Data/Error/plainArgs")
  class FakeToolError extends Error {
    constructor(args) {
      super(args.message)
      this._tag = "Tool.Error"
      Object.defineProperty(this, "message", {
        value: args.message,
        enumerable: false,
        writable: true,
        configurable: true,
      })
      if (args.error !== undefined) this.error = args.error
      if (args.metadata !== undefined) this.metadata = args.metadata
      Object.defineProperty(this, plainArgsSym, {
        value: args,
        enumerable: false,
        writable: false,
        configurable: false,
      })
    }
    toJSON() {
      return { _tag: this._tag, ...this[plainArgsSym] }
    }
  }

  const cause = new Error("ENOENT")
  const meta = { path: "/tmp/a.ts", line: 10 }
  const evToolErr = {
    status: "error",
    error: new FakeToolError({ message: "oldString not found", error: cause, metadata: meta }),
  }
  if (!appendErrorNudge(evToolErr, "try reading first")) throw new Error("Tool.Error appendErrorNudge failed")
  const expectedMsg = `oldString not found${NUDGE_SEPARATOR}try reading first`
  if (evToolErr.error.message !== expectedMsg) throw new Error("Tool.Error message not updated: " + evToolErr.error.message)
  if (evToolErr.error.toJSON().message !== expectedMsg)
    throw new Error("Tool.Error toJSON().message not updated: " + JSON.stringify(evToolErr.error.toJSON()))
  if (evToolErr.error.error !== cause) throw new Error("Tool.Error defect cause lost")
  if (evToolErr.error.metadata !== meta) throw new Error("Tool.Error metadata lost")

  // Plain object error
  const evPlain = { status: "error", error: { message: "plain failure", error: cause, metadata: meta } }
  if (!appendErrorNudge(evPlain, "nudge-plain")) throw new Error("plain error appendErrorNudge failed")
  if (evPlain.error.message !== `plain failure${NUDGE_SEPARATOR}nudge-plain`) throw new Error("plain message wrong")
  if (evPlain.error.error !== cause || evPlain.error.metadata !== meta) throw new Error("plain cause/meta lost")

  // Standard Error / TypeError subclass (where new TypeError(props) would produce "[object Object]")
  const typeErr = new TypeError("bad argument")
  typeErr.metadata = meta
  const evTypeErr = { status: "error", error: typeErr }
  if (!appendErrorNudge(evTypeErr, "nudge-type")) throw new Error("TypeError appendErrorNudge failed")
  if (evTypeErr.error.message !== `bad argument${NUDGE_SEPARATOR}nudge-type`)
    throw new Error("TypeError message wrong: " + evTypeErr.error.message)
  if (evTypeErr.error.metadata !== meta) throw new Error("TypeError metadata lost")

  // Missing / empty message -> false
  if (appendErrorNudge({ status: "error", error: {} }, "nudge") !== false) throw new Error("missing message should fail")
  if (appendErrorNudge({ status: "error", error: { message: "   " } }, "nudge") !== false)
    throw new Error("whitespace message should fail")

  // Frozen ev or frozen ev.error -> false, never throws, original preserved
  const frozenErr = Object.freeze({ message: "cannot touch" })
  const evFrozenChild = { status: "error", error: frozenErr }
  if (appendErrorNudge(evFrozenChild, "nudge") !== false) throw new Error("frozen ev.error should return false")
  if (evFrozenChild.error.message !== "cannot touch") throw new Error("frozen ev.error message altered")

  const evFrozenRoot = Object.freeze({
    status: "error",
    error: new FakeToolError({ message: "frozen root" }),
  })
  if (appendErrorNudge(evFrozenRoot, "nudge") !== false) throw new Error("frozen ev should return false")
  if (evFrozenRoot.error.message !== "frozen root") throw new Error("frozen ev message altered")

  // Non-writable ev.error carrying Tool.Error -> must return false (cannot replace Tool.Error or leave plainArgs stale)
  const evNonWritable = { status: "error" }
  Object.defineProperty(evNonWritable, "error", {
    value: new FakeToolError({ message: "non-writable error prop" }),
    writable: false,
    enumerable: true,
    configurable: false,
  })
  if (appendErrorNudge(evNonWritable, "nudge") !== false)
    throw new Error("non-writable ev.error carrying Tool.Error should return false")
  if (evNonWritable.error.message !== "non-writable error prop")
    throw new Error("non-writable Tool.Error message should not be partially mutated")
})

// Build an isolated stateful harness from spiral-guard.ts's real functions
// with mocked log/toast collectors so evaluate + deliverNudge can be tested
// deterministically without touching /tmp or spawning osascript.
function createEngine(configOverrides = {}) {
  const fnNames = [
    "IGNORED_TOOLS",
    "NUDGE_SEPARATOR",
    "softText",
    "hardText",
    "readSpyText",
    "evictStaleSessions",
    "sessionState",
    "pairFor",
    "targetOf",
    "detectFailure",
    "textOf",
    "probeShape",
    "evaluate",
    "appendNudge",
    "appendErrorNudge",
    "deliverNudge",
  ]
  const code = fnNames.map((n) => detype(extract(n))).join("\n")
  const cfg = {
    DISABLED: false,
    SOFT: 2,
    HARD: 3,
    READ_SPY: 3,
    MAX_FIRES: 2,
    DEBUG: false,
    DELEGATE_HINT: "",
    MAX_SESSIONS: 64,
    ...configOverrides,
  }
  const logs = []
  const toasts = []
  const logFn = (kind, target, extra) => {
    logs.push({ kind, target, ...extra })
  }
  const toastFn = async (title, message, opts) => {
    toasts.push({ title, message, opts })
  }
  const factory = new Function(
    "cfg",
    "log",
    "toast",
    `
    const { DISABLED, SOFT, HARD, READ_SPY, MAX_FIRES, DEBUG, DELEGATE_HINT, MAX_SESSIONS } = cfg;
    const sessions = new Map();
    ${code}
    function handleAfter(ev) {
      const probe =
        ev.status === "completed"
          ? { status: ev.status, message: undefined, content: ev.result?.content, metadata: ev.result?.metadata }
          : ev.status === "error"
            ? { status: ev.status, message: typeof ev.error?.message === "string" ? ev.error.message : undefined, content: undefined, metadata: ev.error?.metadata }
            : { status: undefined, message: undefined, content: undefined, metadata: undefined };
      const nudge = evaluate(ev.sessionID, ev.tool, ev.input, probe);
      if (nudge) deliverNudge(nudge, ev);
      return nudge;
    }
    return { evaluate, deliverNudge, handleAfter, sessions };
    `,
  )
  return { ...factory(cfg, logFn, toastFn), logs, toasts }
}

test("execute.after: status=error delivers nudge in-band, logs injected-error, and only toasts SOFT on fallback", () => {
  const { handleAfter, logs, toasts } = createEngine()
  const sessionID = "ses_err"
  const input = { path: "/app/foo.ts", oldString: "a", newString: "b" }

  // 1st failure: no nudge yet
  const ev1 = { tool: "edit", sessionID, input, status: "error", error: { message: "oldString not found (1)" } }
  handleAfter(ev1)
  if (ev1.error.message !== "oldString not found (1)") throw new Error("1st failure should not be nudged")

  // 2nd failure: SOFT nudge appended to ev.error.message, logs injected-error, NO SOFT toast
  const ev2 = { tool: "edit", sessionID, input, status: "error", error: { message: "oldString not found (2)" } }
  handleAfter(ev2)
  if (!ev2.error.message.includes("[spiral-guard -- SOFT]")) throw new Error("SOFT nudge missing from ev.error.message")
  if (!logs.some((l) => l.kind === "injected-error" && l.target === "edit: /app/foo.ts"))
    throw new Error("expected injected-error log")
  if (toasts.length !== 0) throw new Error("SOFT toast should NOT fire when in-band injection succeeds")

  // 3rd failure: outcome(failed-again) logged for SOFT, HARD nudge appended, HARD toast fires unconditionally
  const ev3 = { tool: "edit", sessionID, input, status: "error", error: { message: "oldString not found (3)" } }
  handleAfter(ev3)
  if (!ev3.error.message.includes("[spiral-guard -- HARD]")) throw new Error("HARD nudge missing from ev.error.message")
  const softOutcome = logs.find((l) => l.kind === "outcome" && l.trigger === "SOFT")
  if (!softOutcome || softOutcome.outcome !== "failed-again" || softOutcome.streak !== 3)
    throw new Error("expected SOFT failed-again outcome at streak 3, got: " + JSON.stringify(softOutcome))
  if (toasts.length !== 1 || !toasts[0].opts?.hard) throw new Error("HARD toast should fire unconditionally")

  // Fallback toast on SOFT when ev.error cannot be rewritten (empty message)
  const { handleAfter: handleFallback, logs: fLogs, toasts: fToasts } = createEngine()
  handleFallback({ tool: "edit", sessionID: "s2", input, status: "error", error: {} })
  handleFallback({ tool: "edit", sessionID: "s2", input, status: "error", error: {} })
  if (!fLogs.some((l) => l.kind === "injected-skipped-error-result"))
    throw new Error("expected injected-skipped-error-result when ev.error.message is missing")
  if (fToasts.length !== 1) throw new Error("expected fallback SOFT toast when appendErrorNudge returns false")
})

test("read-spy: appends one-line hint in-band on READ_SPY-th read, caps at 1 per write cycle, and respects READ_SPY=0", () => {
  const { handleAfter, logs, toasts } = createEngine({ READ_SPY: 3 })
  const sessionID = "ses_read"
  const input = { path: "/app/bar.ts" }

  for (let i = 1; i <= 2; i++) {
    const ev = { tool: "read", sessionID, input, status: "completed", result: { content: "file body" } }
    handleAfter(ev)
    if (ev.result.content !== "file body") throw new Error(`read #${i} should not inject hint`)
  }

  // 3rd read -> in-band read-spy hint, logs read-spy + injected-read-spy, no toast
  const ev3 = { tool: "read", sessionID, input, status: "completed", result: { content: "file body" } }
  handleAfter(ev3)
  if (!ev3.result.content.includes("[spiral-guard -- read-spy]"))
    throw new Error("3rd read missing in-band read-spy hint: " + ev3.result.content)
  if (!logs.some((l) => l.kind === "injected-read-spy" && l.target === "read: /app/bar.ts"))
    throw new Error("missing injected-read-spy log")
  if (toasts.length !== 0) throw new Error("read-spy desktop toast must be off by default")

  // Reads 4..6 without an interleaved write -> capped at 1 fire, no second injection
  for (let i = 4; i <= 6; i++) {
    const ev = { tool: "read", sessionID, input, status: "completed", result: { content: "file body" } }
    handleAfter(ev)
    if (ev.result.content !== "file body") throw new Error(`read #${i} should be capped before write`)
  }

  // Successful write to /app/bar.ts resets readFires and reads
  handleAfter({ tool: "write", sessionID, input, status: "completed", result: { content: "ok" } })
  for (let i = 1; i <= 2; i++) {
    handleAfter({ tool: "read", sessionID, input, status: "completed", result: { content: "file body" } })
  }
  const evAfterWrite = { tool: "read", sessionID, input, status: "completed", result: { content: "file body" } }
  handleAfter(evAfterWrite)
  if (!evAfterWrite.result.content.includes("[spiral-guard -- read-spy]"))
    throw new Error("read-spy should re-arm after a successful write to the same path")

  // SPIRAL_GUARD_READ_SPY=0 disables read-spy completely
  const { handleAfter: handleDisabled, logs: dLogs } = createEngine({ READ_SPY: 0 })
  for (let i = 1; i <= 5; i++) {
    const ev = { tool: "read", sessionID: "s0", input, status: "completed", result: { content: "body" } }
    handleDisabled(ev)
    if (ev.result.content !== "body") throw new Error("READ_SPY=0 must never inject")
  }
  if (dLogs.length !== 0) throw new Error("READ_SPY=0 should emit no read-spy logs")
})

test("outcomes + write-resets-edit: interleaved reads preserve pending edit nudge, write recovers edit streak", () => {
  const { handleAfter, logs } = createEngine()
  const sessionID = "ses_recover"
  const input = { path: "/app/baz.ts" }

  // Two failing edits -> SOFT nudge pending on edit: /app/baz.ts
  handleAfter({ tool: "edit", sessionID, input, status: "error", error: { message: "fail 1" } })
  handleAfter({ tool: "edit", sessionID, input, status: "error", error: { message: "fail 2" } })

  // Interleaved read (as instructed by SOFT nudge) must NOT emit an outcome or clear pendingNudge
  handleAfter({ tool: "read", sessionID, input, status: "completed", result: { content: "lines" } })
  if (logs.some((l) => l.kind === "outcome")) throw new Error("interleaved read must not resolve edit pendingNudge")

  // Switching to a successful write on the same path resolves edit's pendingNudge as recovered and resets edit's streak
  handleAfter({ tool: "write", sessionID, input, status: "completed", result: { content: "written" } })
  const outcome = logs.find((l) => l.kind === "outcome" && l.target === "edit: /app/baz.ts")
  if (!outcome || outcome.outcome !== "recovered" || outcome.trigger !== "SOFT" || outcome.streak !== 2)
    throw new Error("write should log recovered outcome for pending edit nudge: " + JSON.stringify(outcome))
  const reset = logs.find((l) => l.kind === "fail-streak-reset" && l.target === "edit: /app/baz.ts")
  if (!reset || reset.streak !== 2)
    throw new Error("write should log fail-streak-reset for edit: " + JSON.stringify(reset))

  // A subsequent single failing edit starts back at streak 1 (not streak 3 / HARD)
  handleAfter({ tool: "edit", sessionID, input, status: "error", error: { message: "fail again" } })
  const lastFail = [...logs].reverse().find((l) => l.kind === "failure" && l.target === "edit: /app/baz.ts")
  if (!lastFail || lastFail.streak !== 1)
    throw new Error("expected edit streak to restart at 1 after write reset, got: " + JSON.stringify(lastFail))

  // Trigger SOFT on edit: /app/baz.ts again (streak 2), then move on to a different non-read target
  handleAfter({ tool: "edit", sessionID, input, status: "error", error: { message: "fail 2 again" } })
  handleAfter({ tool: "bash", sessionID, input: { command: "git status" }, status: "completed", result: { content: "ok" } })
  const movedOn = [...logs].reverse().find((l) => l.kind === "outcome" && l.target === "edit: /app/baz.ts")
  if (!movedOn || movedOn.outcome !== "moved-on" || movedOn.trigger !== "SOFT")
    throw new Error("expected moved-on outcome when switching to another non-read target: " + JSON.stringify(movedOn))
})

test("summarize-log: parses triggers, delivery breakdown, and per-tool/per-delivery outcomes", () => {
  const sampleLines = [
    // 1. bash SOFT -> injected -> recovered
    { kind: "failure", sessionID: "s1", target: "bash: npm test", streak: 1 },
    { kind: "failure", sessionID: "s1", target: "bash: npm test", streak: 2 },
    { kind: "SOFT", sessionID: "s1", target: "bash: npm test", text: "soft" },
    { kind: "injected", sessionID: "s1", target: "bash: npm test", text: "soft" },
    { kind: "outcome", sessionID: "s1", target: "bash: npm test", trigger: "SOFT", outcome: "recovered", streak: 2 },
    { kind: "fail-streak-reset", sessionID: "s1", target: "bash: npm test", streak: 2 },

    // 2. edit SOFT (injected-error) -> interleaved read-spy -> recovered via edit
    { kind: "failure", sessionID: "s1", target: "edit: /a.ts", streak: 2 },
    { kind: "SOFT", sessionID: "s1", target: "edit: /a.ts", text: "soft" },
    { kind: "injected-error", sessionID: "s1", target: "edit: /a.ts", text: "soft" },
    { kind: "read-spy", sessionID: "s1", target: "read: /a.ts", text: "spy" },
    { kind: "injected-read-spy", sessionID: "s1", target: "read: /a.ts", text: "spy" },
    { kind: "outcome", sessionID: "s1", target: "edit: /a.ts", trigger: "SOFT", outcome: "recovered", streak: 2 },
    { kind: "fail-streak-reset", sessionID: "s1", target: "edit: /a.ts", streak: 2 },

    // 3. edit SOFT (injected-error) -> failed-again -> HARD (injected-skipped-error-result) -> moved-on via subsequent activity on another target
    { kind: "SOFT", sessionID: "s2", target: "edit: /b.ts", text: "soft" },
    { kind: "injected-error", sessionID: "s2", target: "edit: /b.ts", text: "soft" },
    { kind: "outcome", sessionID: "s2", target: "edit: /b.ts", trigger: "SOFT", outcome: "failed-again", streak: 3 },
    { kind: "failure", sessionID: "s2", target: "edit: /b.ts", streak: 3 },
    { kind: "HARD", sessionID: "s2", target: "edit: /b.ts", text: "hard" },
    { kind: "injected-skipped-error-result", sessionID: "s2", target: "edit: /b.ts", text: "hard" },
    { kind: "failure", sessionID: "s2", target: "bash: git status", streak: 1 },

    // 4. Unresolved SOFT at EOF stays in `pending` (not inflated into moved-on)
    { kind: "SOFT", sessionID: "s3", target: "bash: npm run build", text: "soft" },
    { kind: "injected", sessionID: "s3", target: "bash: npm run build", text: "soft" },
  ]
  const jsonl = sampleLines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  const s = summarizeLog(jsonl)

  if (s.triggers.total !== 6 || s.triggers.SOFT !== 4 || s.triggers.HARD !== 1 || s.triggers["read-spy"] !== 1)
    throw new Error("trigger counts wrong: " + JSON.stringify(s.triggers))
  if (
    s.delivery.injected !== 2 ||
    s.delivery["injected-error"] !== 2 ||
    s.delivery["injected-read-spy"] !== 1 ||
    s.delivery["injected-skipped-error-result"] !== 1
  )
    throw new Error("delivery counts wrong: " + JSON.stringify(s.delivery))
  if (
    s.outcomes.recovered !== 2 ||
    s.outcomes["failed-again"] !== 1 ||
    s.outcomes["moved-on"] !== 1 ||
    s.outcomes.pending !== 1
  )
    throw new Error("outcome counts wrong: " + JSON.stringify(s.outcomes))
  if (
    s.byTool.bash.recovered !== 1 ||
    s.byTool.bash.pending !== 1 ||
    s.byTool.edit.recovered !== 1 ||
    s.byTool.edit["failed-again"] !== 1 ||
    s.byTool.edit["moved-on"] !== 1
  )
    throw new Error("byTool counts wrong: " + JSON.stringify(s.byTool))
  if (
    s.byDelivery.injected.recovered !== 1 ||
    s.byDelivery.injected.pending !== 1 ||
    s.byDelivery["injected-error"].recovered !== 1 ||
    s.byDelivery["injected-error"]["failed-again"] !== 1 ||
    s.byDelivery["injected-skipped-error-result"]["moved-on"] !== 1
  )
    throw new Error("byDelivery counts wrong: " + JSON.stringify(s.byDelivery))

  const formatted = formatSummary(s)
  for (const token of [
    "Triggers: total=6",
    "injected=2",
    "injected-error=2",
    "injected-read-spy=1",
    "injected-skipped-error-result=1",
    "recovered=2",
    "failed-again=1",
    "moved-on=1",
    "pending=1",
  ]) {
    if (!formatted.includes(token)) throw new Error(`formatted output missing "${token}":\n${formatted}`)
  }

  // Verify CLI entrypoint end-to-end on a temp file
  const dir = mkdtempSync(join(tmpdir(), "spiral-guard-test-"))
  try {
    const p = join(dir, "test.jsonl")
    writeFileSync(p, jsonl, "utf8")
    const cliOut = execFileSync(process.execPath, [new URL("./scripts/summarize-log.mjs", import.meta.url).pathname, p], {
      encoding: "utf8",
    })
    if (!cliOut.includes("Triggers: total=6") || !cliOut.includes("recovered=2") || !cliOut.includes("pending=1"))
      throw new Error("CLI output mismatch:\n" + cliOut)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
