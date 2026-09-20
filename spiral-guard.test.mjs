// Unit tests for spiral-guard's pure functions: failure detection, target
// extraction, and toast XML escaping. Harness technique: extract named
// declarations from the real .ts source, strip TS-only syntax, evaluate in a
// shared closure. Run with: node --test spiral-guard.test.mjs
import { readFileSync } from "node:fs"
import { test } from "node:test"

const src = readFileSync(new URL("./spiral-guard.ts", import.meta.url), "utf8")

function extract(name) {
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
      // inline-object param type: `out: { title?: ...; ... })` -> `out)`
      .replace(/(\w+)\s*:\s*\{[^{}]*\}\s*(?=\))/g, "$1")
      // `): string | undefined {` -> `) {`
      .replace(/\)\s*:\s*string\s*\|\s*undefined\s*\{/g, ") {")
      // `): string {` -> `) {`
      .replace(new RegExp(String.raw`\)\s*:\s*${TYPE}\s*\{`, "g"), ") {")
      // bare param annotations: `(tool: string, out)` -> `(tool, out)`
      .replace(new RegExp(String.raw`(\(|,\s*)(\w+)\s*:\s*${TYPE}`, "g"), "$1$2")
  )
}

const names = ["IGNORED_TOOLS", "targetOf", "detectFailure", "xmlEscape"]
const body = names.map((n) => detype(extract(n))).join("\n")
const { targetOf, detectFailure, xmlEscape, IGNORED_TOOLS } = new Function(
  body + "\nreturn { targetOf, detectFailure, xmlEscape, IGNORED_TOOLS }",
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

test("detectFailure: metadata shapes, most-trusted first", () => {
  if (detectFailure("bash", { metadata: { error: "boom" } }) !== "boom") throw new Error("meta.error string missed")
  if (detectFailure("bash", { metadata: { error: { message: "wrapped" } } }) !== "wrapped") throw new Error("meta.error.message missed")
  if (detectFailure("bash", { metadata: { ok: false } }) !== "ok=false") throw new Error("ok:false missed")
  if (detectFailure("bash", { metadata: { status: "error" } }) !== "status=error") throw new Error("status:error missed")
  if (detectFailure("bash", { metadata: { exit: 127 } }) !== "exit=127") throw new Error("non-zero exit missed")
  if (detectFailure("bash", { metadata: { exit: 0 } }) !== undefined) throw new Error("zero exit false positive")
})

test("detectFailure: stderr handling is conservative", () => {
  // stderr with no exit code at all -> counts (nothing else to judge by)
  if (!String(detectFailure("bash", { metadata: { stderr: "fatal: no such file" } })).startsWith("stderr:"))
    throw new Error("stderr-only missed")
  // stderr WITH zero exit -> warnings are not failures
  if (detectFailure("bash", { metadata: { exit: 0, stderr: "deprecation warning" } }) !== undefined)
    throw new Error("exit 0 + stderr false positive")
  // stderr with non-zero exit -> the EXIT rule fires first (plain exit=N);
  // the exit+stderr branch only applies when exit is 0 -- and 0+stderr is
  // deliberately NOT a failure (warnings are not errors).
  if (detectFailure("bash", { metadata: { exit: 2, stderr: "usage" } }) !== "exit=2")
    throw new Error("exit precedence over stderr wrong")
})

test("detectFailure: narrow terminal-text patterns, bash only", () => {
  const hit = (out) => detectFailure("bash", { output: out })
  if (!String(hit("sh: foo: command not found")).includes("command not found")) throw new Error("cnf missed")
  if (!String(hit("bash: line 1: cd: /x: Permission denied")).includes("Permission denied")) throw new Error("perm missed")
  if (!String(hit("Exit code 1")).startsWith("text:")) throw new Error("exit-code banner missed")
  if (hit("Exit code 0") !== undefined) throw new Error("exit 0 banner false positive")
  if (!String(hit("Traceback (most recent call last):")).includes("Traceback")) throw new Error("traceback missed")
  if (!String(hit("Segmentation fault (core dumped)")).includes("Segmentation")) throw new Error("segfault missed")
  // loose words must NOT count as failures
  if (hit("npm WARN deprecated something-or-other") !== undefined) throw new Error("loose-word false positive")
  if (hit("0 errors, 0 warnings") !== undefined) throw new Error("loose-word false positive 2")
  // non-bash tools never sniff raw output
  if (detectFailure("edit", { output: "command not found" }) !== undefined) throw new Error("non-bash text sniff")
})

test("detectFailure: clean results and empty metadata are not failures", () => {
  if (detectFailure("bash", { output: "all good" }) !== undefined) throw new Error("clean false positive")
  if (detectFailure("read", {}) !== undefined) throw new Error("empty meta false positive")
  if (detectFailure("read", { metadata: {} }) !== undefined) throw new Error("empty-obj meta false positive")
})

test("xmlEscape: every XML metacharacter is escaped", () => {
  const out = xmlEscape(`a&b<c>d"e'f`)
  if (out !== "a&amp;b&lt;c&gt;d&quot;e&apos;f") throw new Error("xmlEscape wrong: " + out)
})

test("IGNORED_TOOLS: meta/flaky tools are listed", () => {
  for (const t of ["task", "skill", "todowrite", "todoread", "webfetch"]) {
    if (!IGNORED_TOOLS.has(t)) throw new Error(t + " missing from IGNORED_TOOLS")
  }
})
