# spiral-guard

An [opencode](https://opencode.ai) plugin that watches for **failure
spirals** -- an agent repeating failing attempts, or circling a file
read-after-read without writing -- and nudges it out of the loop before
the rest of the session burns on it.

## The gap it fills

opencode ships a built-in `doom_loop` permission check that interrupts
after 3 *identical* tool calls. That misses the two spirals that actually
eat sessions:

- **Different-args failures** -- three different failing edits, a command
  retried with tweaks, a search retried with different terms. No two
  calls are identical, so the identical-call matcher never fires.
- **Read-without-write circling** -- nothing failed and nothing repeated:
  the agent just re-reads the same file over and over, going nowhere.

spiral-guard detects both, and instead of interrupting a human, it
**coaches the agent**: a nudge is appended to the FAILING tool's own
output -- exactly where the model is already looking, at the moment of
failure -- naming the escalation options (change approach, re-read with
offsets, delegate to a specialized subagent). No human in the loop, no
blocked call, no swallowed error.

## How it works

| Trigger | Default | Action |
| --------- | --------- | -------- |
| SOFT | 2 consecutive failures of one target | nudge appended to the tool output + desktop toast: change approach or delegate |
| HARD | 3 consecutive failures of one target | stronger nudge: stop, delegate, or diagnose the wrong assumption |
| Read-spy | 3 reads of one file with no interleaved write | toast only (are you about to loop?) |

- A target's failure streak resets on any success anywhere in between.
- SOFT injections are capped per target per session (default 2) -- the
  HARD escalation always gets through.
- The JSONL trigger log (default `/tmp/opencode/spiral-guard.jsonl`) makes
  every fire auditable; the log file/directory are created 0600/0700
  because failing-command text can contain secrets.
- NUDGE-ONLY by design: it never auto-delegates, never blocks a call, and
  never swallows errors. Worst case you see a toast you ignore.

Flaky-tool failures from meta tools (task, skill, todowrite, webfetch,
custom search tools) are ignored so their retries are not misread as
spirals.

## Install

**One line, installs straight from this repo** (verified against
opencode's plugin installer) -- add to `~/.config/opencode/opencode.jsonc`:

~~~jsonc
"plugin": ["github:oakwood-commons/spiral-guard"]
~~~

Then restart opencode (plugins load once at startup). opencode clones the
repo into its own package cache (`~/.cache/opencode/packages/`) -- no
manual clone, no copy, no npm account.

**Updating to a newer version**: the cached copy is only fetched once, so
after upstream changes, clear the cached clone and restart:

~~~bash
rm -rf ~/.cache/opencode/packages/github:oakwood-commons/spiral-guard
~~~

Alternatives, when you prefer them:

- **Global file copy** (no git spec; you own updates by re-copying):
  `cp spiral-guard.ts ~/.config/opencode/plugins/` -- auto-discovered there.
- **Per-project**: copy into that repo's `.opencode/plugin/` -- scoped to
  sessions in that repo only.
- **Explicit local path after a manual clone**:
  `"plugin": ["file:///abs/path/to/spiral-guard/spiral-guard.ts"]`

Requires no dependencies beyond opencode's own `@opencode-ai/plugin` API.

## Tuning

All knobs are environment variables -- no code edits:

| Env | Default | Meaning |
| ----- | --------- | --------- |
| `SPIRAL_GUARD_FAIL_THRESHOLD` | 2 | SOFT trigger after N consecutive failures |
| `SPIRAL_GUARD_HARD_THRESHOLD` | 3 | HARD trigger after N |
| `SPIRAL_GUARD_READ_SPY` | 3 | toast after N reads with no write |
| `SPIRAL_GUARD_MAX_FIRES` | 2 | max SOFT+HARD injections per target per session |
| `SPIRAL_GUARD_DELEGATE_HINT` | (generic) | names YOUR delegation target(s), e.g. `"a cheap mechanical-work subagent"` -- spliced into the nudge text |
| `SPIRAL_GUARD_LOG` | `/tmp/opencode/spiral-guard.jsonl` | JSONL trigger log path |
| `SPIRAL_GUARD_DEBUG` | off | dump the raw hook shape per tool call |
| `SPIRAL_GUARD_DISABLED` | off | turn the plugin off entirely |

## Related tools (and why they compose)

- **opencode built-in `doom_loop`**: identical repeated calls -> asks a
  human. spiral-guard covers different-args failures and self-recovery;
  an identical-call spiral can hit both (your ask, plus our nudge).
- **opencode-auto-resume**: frozen/stalled generation streams. Orthogonal
  -- that is a dead-stream class, not a behavior class.
- **Failure/friction recorders** (observability plugins): record what went
  wrong. spiral-guard acts on it, in the loop, at the moment of failure.

## Tests

~~~bash
npm test
~~~

Covers the failure-detection truth table (metadata shapes + narrow
terminal-text patterns), target identity extraction, and toast XML
escaping.

## License

MIT -- see [LICENSE](LICENSE).
