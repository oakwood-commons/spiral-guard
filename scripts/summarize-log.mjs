#!/usr/bin/env node
// scripts/summarize-log.mjs -- zero-dependency CLI + library to summarize
// spiral-guard trigger, delivery, and outcome effectiveness from a JSONL log.

import { existsSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const DELIVERY_KINDS = [
  "injected",
  "injected-error",
  "injected-read-spy",
  "injected-skipped-error-result",
  "inject-failed",
]

function emptyOutcomeBucket() {
  return { total: 0, recovered: 0, "failed-again": 0, "moved-on": 0, pending: 0 }
}

function toolOfTarget(target) {
  if (typeof target !== "string" || !target) return "unknown"
  const idx = target.indexOf(":")
  return idx === -1 ? target.trim() : target.slice(0, idx).trim()
}

export function summarizeLog(content) {
  const triggers = {
    total: 0,
    nudgeTotal: 0,
    SOFT: 0,
    HARD: 0,
    "read-spy": 0,
  }
  const delivery = {
    injected: 0,
    "injected-error": 0,
    "injected-read-spy": 0,
    "injected-skipped-error-result": 0,
    "inject-failed": 0,
  }
  const outcomes = {
    recovered: 0,
    "failed-again": 0,
    "moved-on": 0,
    pending: 0,
  }
  const byTool = {}
  const byDelivery = {}
  const byTrigger = {
    SOFT: emptyOutcomeBucket(),
    HARD: emptyOutcomeBucket(),
  }

  function adjustOutcome(item, outcome, delta) {
    if (!outcomes[outcome] && outcomes[outcome] !== 0) return
    outcomes[outcome] += delta
    const tool = item.tool || "unknown"
    if (!byTool[tool]) byTool[tool] = emptyOutcomeBucket()
    byTool[tool].total += delta
    byTool[tool][outcome] += delta

    const deliv = item.delivery || "unrecorded"
    if (!byDelivery[deliv]) byDelivery[deliv] = emptyOutcomeBucket()
    byDelivery[deliv].total += delta
    byDelivery[deliv][outcome] += delta

    if (item.trigger && byTrigger[item.trigger]) {
      byTrigger[item.trigger].total += delta
      byTrigger[item.trigger][outcome] += delta
    }
  }

  function recordOutcome(item, outcome) {
    adjustOutcome(item, outcome, 1)
  }

  // Keyed by `${sessionID}\0${target}` for pending SOFT/HARD nudges.
  const pending = new Map()
  // Keyed by `${sessionID}\0${target}` for fallback-inferred outcomes so a
  // later explicit `kind === "outcome"` record for the same trigger reconciles
  // (replaces) the inferred outcome rather than double-counting.
  const inferred = new Map()
  let totalLines = 0

  function resolveOtherTargetsInSession(sessionID, currentTarget, currentKind) {
    if (toolOfTarget(currentTarget) === "read") return
    // A successful write (`fail-streak-reset` on `write: <path>`) recovers a
    // pending `edit: <path>` rather than moving on from it.
    const recoveredEditTarget =
      currentKind === "fail-streak-reset" && currentTarget.startsWith("write: ")
        ? `edit: ${currentTarget.slice("write: ".length)}`
        : undefined
    for (const [k, cur] of pending) {
      if (cur.sessionID === sessionID && cur.target !== currentTarget && cur.target !== recoveredEditTarget) {
        pending.delete(k)
        recordOutcome(cur, "moved-on")
        inferred.set(k, { item: cur, outcome: "moved-on" })
      }
    }
  }

  const lines = String(content ?? "").split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== "object") continue
    totalLines += 1

    const kind = String(entry.kind ?? "")
    const target = String(entry.target ?? "")
    const sessionID = String(entry.sessionID ?? "")
    const tool = toolOfTarget(target)
    const key = `${sessionID}\0${target}`

    if (kind === "SOFT" || kind === "HARD") {
      if (tool !== "read") {
        resolveOtherTargetsInSession(sessionID, target, kind)
      }
      triggers[kind] += 1
      triggers.nudgeTotal += 1
      triggers.total += 1
      inferred.delete(key)
      // If a previous nudge on the exact same (sessionID, target) was still
      // pending without an explicit outcome, it failed again to reach here.
      const prev = pending.get(key)
      if (prev) {
        recordOutcome(prev, "failed-again")
      }
      pending.set(key, {
        sessionID,
        target,
        tool,
        trigger: kind,
        delivery: "unrecorded",
      })
      continue
    }

    if (kind === "read-spy") {
      triggers["read-spy"] += 1
      triggers.total += 1
      continue
    }

    if (DELIVERY_KINDS.includes(kind)) {
      delivery[kind] += 1
      if (kind !== "injected-read-spy") {
        const cur = pending.get(key)
        if (cur && cur.delivery === "unrecorded") {
          cur.delivery = kind
        }
      }
      continue
    }

    if (kind === "outcome") {
      const out = String(entry.outcome ?? "")
      if (out === "recovered" || out === "failed-again" || out === "moved-on") {
        const cur = pending.get(key)
        if (cur) {
          pending.delete(key)
          inferred.delete(key)
          recordOutcome(cur, out)
        } else if (inferred.has(key)) {
          const prevInf = inferred.get(key)
          inferred.delete(key)
          adjustOutcome(prevInf.item, prevInf.outcome, -1)
          recordOutcome(prevInf.item, out)
        } else {
          recordOutcome(
            {
              sessionID,
              target,
              tool,
              trigger: typeof entry.trigger === "string" ? entry.trigger : undefined,
              delivery: "unrecorded",
            },
            out,
          )
        }
      }
      continue
    }

    // Fallback for historical logs (pre-outcome event): resolve pending nudge
    // on the next fail-streak-reset or failure for that exact target (including
    // `read: <path>`), or as moved-on when subsequent non-read activity in the
    // session targets another target. Interleaved read calls never touch pending
    // nudges on other targets.
    if (tool !== "read") {
      resolveOtherTargetsInSession(sessionID, target, kind)
    }

    if (kind === "fail-streak-reset") {
      const cur = pending.get(key)
      if (cur) {
        pending.delete(key)
        recordOutcome(cur, "recovered")
        inferred.set(key, { item: cur, outcome: "recovered" })
      }
      continue
    }

    if (kind === "failure") {
      const cur = pending.get(key)
      if (cur) {
        pending.delete(key)
        recordOutcome(cur, "failed-again")
        inferred.set(key, { item: cur, outcome: "failed-again" })
      }
      continue
    }
  }

  // Any SOFT/HARD trigger still unresolved at EOF stays in `pending` -- EOF
  // alone does not establish that the agent moved on.
  for (const [, cur] of pending) {
    recordOutcome(cur, "pending")
  }
  pending.clear()

  return {
    totalLines,
    triggers,
    delivery,
    outcomes,
    byTool,
    byDelivery,
    byTrigger,
  }
}

export function formatSummary(summary) {
  const lines = []
  lines.push("spiral-guard log summary")
  lines.push("========================")
  lines.push(`Total log entries: ${summary.totalLines}`)
  lines.push(
    `Triggers: total=${summary.triggers.total} (SOFT=${summary.triggers.SOFT}, HARD=${summary.triggers.HARD}, read-spy=${summary.triggers["read-spy"]})`,
  )
  lines.push(
    `Delivery: injected=${summary.delivery.injected}, injected-error=${summary.delivery["injected-error"]}, injected-read-spy=${summary.delivery["injected-read-spy"]}, injected-skipped-error-result=${summary.delivery["injected-skipped-error-result"]}` +
      (summary.delivery["inject-failed"] ? `, inject-failed=${summary.delivery["inject-failed"]}` : ""),
  )
  lines.push(
    `Outcomes (SOFT+HARD): recovered=${summary.outcomes.recovered}, failed-again=${summary.outcomes["failed-again"]}, moved-on=${summary.outcomes["moved-on"]}, pending=${summary.outcomes.pending}`,
  )

  const delivKeys = Object.keys(summary.byDelivery)
  if (delivKeys.length > 0) {
    lines.push("")
    lines.push("By delivery:")
    for (const k of delivKeys) {
      const b = summary.byDelivery[k]
      lines.push(
        `  ${k}: total=${b.total}, recovered=${b.recovered}, failed-again=${b["failed-again"]}, moved-on=${b["moved-on"]}, pending=${b.pending}`,
      )
    }
  }

  const toolKeys = Object.keys(summary.byTool)
  if (toolKeys.length > 0) {
    lines.push("")
    lines.push("By tool:")
    for (const k of toolKeys) {
      const b = summary.byTool[k]
      lines.push(
        `  ${k}: total=${b.total}, recovered=${b.recovered}, failed-again=${b["failed-again"]}, moved-on=${b["moved-on"]}, pending=${b.pending}`,
      )
    }
  }

  return lines.join("\n")
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const asJson = args.includes("--json")
  const fileArg = args.find((a) => a !== "--json")
  const logPath = fileArg ?? process.env.SPIRAL_GUARD_LOG ?? "/tmp/opencode/spiral-guard.jsonl"
  const raw = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
  const summary = summarizeLog(raw)
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(formatSummary(summary))
  }
}
