// Unit tests for spiral-guard's pure functions: failure detection, target
// extraction, output-text flattening, and toast XML escaping. Harness
// technique: extract named declarations from the real .ts source, strip
// TS-only syntax, evaluate in a shared closure. Run with:
// node --test spiral-guard.test.mjs
import { readFileSync } from "node:fs"
import { test } from "node:test"

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
  const TYPE = String.raw`[A-Za-z_$][\w$]*(?:\[\])?`
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

const names = ["IGNORED_TOOLS", "targetOf", "detectFailure", "textOf", "xmlEscape"]
const body = names.map((n) => detype(extract(n))).join("\n")
const { targetOf, detectFailure, textOf, xmlEscape, IGNORED_TOOLS } = new Function(
  body + "\nreturn { targetOf, detectFailure, textOf, xmlEscape, IGNORED_TOOLS }",
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
})
