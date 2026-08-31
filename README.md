# cbds

**Reliable multi-agent orchestration for the Herdr herd.**

cbds is a native [Herdr](https://herdr.dev) plugin and CLI that makes one thing work
properly: **receiving the result** when an orchestrating agent sends work to another
pane.

```
cbds run create --objective "Ship the billing audit"
cbds task create --spec "Fix the footer overlap below 380px"
cbds dispatch start --task tsk_… --agent claude     # splits a pane, starts the agent
cbds wait --task tsk_… --timeout 900000             # blocks until the worker reports
```

Zero runtime dependencies. Linux, macOS, Windows.

---

## The problem

Herdr's sending primitives are excellent. `pane split`, `agent start` and `agent prompt`
do exactly what they say. The receive side is where multi-agent work in a terminal
multiplexer falls apart:

| What people try | Why it breaks |
|---|---|
| `herdr agent wait --until idle` | `idle`/`done` is a *lifecycle* state, not a *turn* result. An agent that pauses to think or finishes a sub-step reads as settled. Herdr's own docs say `unknown` "does not prove completion". |
| `herdr agent read` and parse the screen | Racy, and agents on the alternate screen lose scrollback entirely — rows that leave the alt screen never enter Herdr's host scrollback, so a bigger `--lines` cannot recover them. |
| `pane wait-output --match "DONE"` | A sentinel in a transcript is unauthenticated. Any echo, any quoted instruction, any retry matches it. It cannot tell attempt #1 from attempt #2. |
| Keep a shell blocked on the worker | The result exists only inside that process. Crash, detach, or restart and it is gone. |

The common flaw: **the result lives in the terminal.** A terminal is a rendering surface,
not a datastore.

## Two verbs, not one

cbds began with only `dispatch`, and a system with one verb makes everything look like
its verb: asked to have two agents greet each other, it wrapped "hola" in a completion
contract. Orca and Plano both carry two. cbds does now:

```bash
# Talk. The other agent receives exactly this text and nothing else.
cbds spawn pi --say "¡Hola! ¿Qué modelo eres?"
cbds say tsk_m1a9x… "el diseño cambió, usa el componente compartido"

# Dispatch. You are blocked on a structured, ID-authenticated result.
cbds dispatch start --task tsk_… --agent claude
cbds wait --task tsk_… --timeout 900000
```

If nobody is blocked waiting on a machine-readable outcome, it is not a dispatch.

## The fix

> **The transcript is a hint. The durable report is the truth.**

cbds adds a completion *contract*, modelled on the part of Orca's orchestration layer
that actually makes completion reliable, rebuilt natively on Herdr's own primitives.

1. **`dispatch start`** creates a real Herdr pane, injects the worker's identity into the
   **pane environment** (`CBDS_TASK_ID`, `CBDS_DISPATCH_ID`, …) *and* into a prose
   preamble, then starts the agent.
2. **`cbds done`** — run by the worker — writes an atomic, fsynced report to disk. It is
   accepted only when the task id **and** dispatch id match the task's *live* dispatch.
3. **`cbds wait`** blocks on that durable inbox, woken by a filesystem watch, backed by a
   safety poll, bounded by a mandatory timeout.

Three properties fall out, and they are the whole product:

- **Durable before delivered.** The report exists on disk before anyone is told. If the
  orchestrator is dead or Herdr has restarted, a `cbds wait` an hour later returns it
  *instantly*. You never keep a shell alive just to catch a result.
- **Authenticated by dual ID.** A superseded retry, a command replayed from scrollback,
  or a confused agent quoting an old preamble is rejected with `stale_dispatch` — and the
  rejection is **recorded**, so you can see that a zombie worker tried to report.
- **Waking is a hint; correctness is a re-read.** `fs.watch` is a latency optimisation.
  Every wake re-scans the durable inbox. Lose every notification and you lose latency,
  never a result.

---

## Install

**As a Herdr plugin** (recommended — adds the board pane, actions and a keybinding):

```bash
herdr plugin install zqkra/cbds
```

**For development:**

```bash
git clone https://github.com/zqkra/cbds
herdr plugin link "$PWD/cbds"
```

**Install the worker skill into your agents** — this is what makes dispatches cheap:

```bash
cbds skill install                              # claude, codex, opencode, pi, gemini, grok + ~/.agents
npx skills add zqkra/cbds --skill cbds -g       # alternative, covers more agents
```

A worker that holds the skill already knows the protocol, so a dispatch to it is the
task plus one anchor line (~25 tokens). Without it, cbds falls back to a ~380-token
contract. `cbds skill status` shows who has it.

**Put `cbds` on your PATH** so you can drive it by hand:

```bash
npm install -g ./cbds        # or: ln -s "$PWD/cbds/bin/cbds" ~/.local/bin/cbds
```

Workers do not need this step: `dispatch start` puts the `cbds` shim on the worker
pane's PATH automatically.

Requires Node ≥ 18.17 and Herdr ≥ 0.8.0. There is no build step and no `node_modules`:
`herdr plugin install` clones and works.

## Quick start

```bash
cbds status                                            # what am I? what is live?

cbds run create --objective "Ship the billing audit"
A=$(cbds task create --spec "Fix the footer overlap below 380px" --json | jq -r .data.task_id)
B=$(cbds task create --spec "Audit the invoice totals" --json | jq -r .data.task_id)

cbds dispatch start --task $A --agent claude           # -> pane w1:p4
cbds dispatch start --task $B --agent codex            # -> pane w1:p5

cbds wait --all --timeout 900000                       # both workers, one blocking call

cbds release <dispatch_id>                             # capture transcript, close pane
```

The worker, in its own pane, does the work and then runs exactly one of:

```bash
cbds done --outcome succeeded --subject "Fixed" --body "…" --files-modified "src/Footer.tsx"
cbds done --outcome failed    --subject "…"     --body "why it failed"
cbds done --outcome blocked   --subject "…"     --question "what I need to proceed"
```

It never passes ids — they come from its pane environment.

---

## Teaching the worker, not just catching it

The recovery below exists because the rule can be missed. The rule itself was the
actual fix.

A worker's task spec very often ends with a section headed **"Report"**, **"Al
reportar"** or **"When finished"** — and a smaller model reads that as *write prose*.
It does the work, prints a careful summary on its own screen, and stops. So both the
skill and the preamble now say the thing that was missing:

> Writing a summary on your screen is **not** reporting — nobody reads your screen. If
> the task has a section headed "Report" / "Al reportar" / "When finished", that
> describes what belongs in `--body`. Put it **inside** the `cbds done` command.

The skill leads with it, before anything a worker might skim past, and its frontmatter
now triggers on *receiving* a dispatch rather than only on orchestrating one — a worker
that never loads the skill cannot follow it.

Re-run of the exact spec shape that failed: reported in 20s, zero reminders needed,
with the "Al reportar" content correctly inside `--body`.

## A worker that forgets to report is recovered

The contract cannot make a model run a command. Observed in a real run on a small
model: the worker wrote the code, ran 151 tests, then printed its findings as prose on
its own screen — addressing the coordinator by name — and went idle. The result
existed and was unreachable.

That state is detectable: **agent idle, dispatch unsettled** means finished and not
reported. `cbds wait` sweeps for it and sends one short reminder; the worker
summarises in a `cbds done` call without redoing the work. In the run above it
reported 10 seconds later, in full.

```bash
cbds nudge --all --dry-run     # who finished without reporting?
cbds nudge --all               # remind them
```

Capped at 2 reminders after a 25s grace, so a worker about to report is not
interrupted and one that ignores two is left to the timeout. Related: `--contract
auto` will not pair a one-line anchor with a spec over ~900 tokens, because a single
trailing line loses against a wall of text.

## A report cannot go unread

`cbds wait` is the receive primitive, but a coordinator that ends its turn instead of
blocking on it would never learn anything: a CLI cannot push into an agent's context.
Herdr can, so cbds uses it.

When a report is accepted and **nobody is blocked in `cbds wait`**, it is delivered
into the coordinator's pane:

```
[cbds] migracion-0039-sw2h → succeeded: 0039 written, verified, NOT applied
tsk_m1cqe… · full report: cbds report show rpt_… · 2 worker(s) still running
```

`cbds wait` registers itself while it blocks, so an active waiter suppresses the push —
you are never told twice. A waiter whose process died is pruned, so a crash cannot
silence notifications for ever. `--no-notify` opts out, and a failed delivery never
fails the report: it is already durable on disk.

## The relationship is mutual, and named

A dispatch obliges both sides. The worker owes exactly one report; the coordinator
owes an answer to anything the worker asks. cbds makes each side visible to the other:

- the worker's pane carries `CBDS_COORDINATOR`, its preamble names the coordinator,
  and `cbds whoami` prints it
- workers get readable names from their task — `fix-the-footer-overlap-vzdn` — which
  is how you address them: `cbds say fix-the-footer-overlap-vzdn "…"`
- tabs, pane titles and Herdr state labels all use the same distinctive label
- `cbds status` and `cbds board` print **open questions in red**, with the exact reply
  command, because a worker blocked inside `ask` looks like a healthy idle system

```
2 worker(s) are BLOCKED waiting on you:
  rpt_m1a9x…  shared component or page-only?
    cbds reply --id rpt_m1a9x… --body "<answer>"
```

## Architecture

```
              orchestrator (any pane; may die and come back)
                      │
        cbds dispatch start ─────────────┐
                      │                  │  herdr pane split --env CBDS_*
                      │                  │  herdr agent start / agent prompt
                      ▼                  ▼
            ┌──────────────────┐   ┌──────────────────────┐
            │  .cbds/  (truth) │   │  Herdr pane w1:p4    │
            │   runs/<id>/     │   │  worker agent        │
            │     run.json     │   │  env: CBDS_TASK_ID   │
            │     tasks/       │   │       CBDS_DISPATCH  │
            │     dispatches/  │   └──────────┬───────────┘
            │     inbox/       │◀─────────────┘  cbds done
            │     cursor.json  │      (atomic write + fsync)
            └────────┬─────────┘
                     │  fs.watch  +  safety poll  +  mandatory timeout
                     ▼
                cbds wait ──▶ the report
```

**Herdr's event bus is used only as a hint.** `events.subscribe` streams `pane_closed` /
`pane_exited`, which lets a wait fail *fast* when a worker pane dies. It can never mark a
task complete: those events are a closed built-in set and are not durable across a server
restart, so they are structurally unfit to carry a completion signal.

### Workers are placed, not piled

Splitting the coordinator's pane for every worker ends in a tab of 10-character
strips. cbds places them instead: while the tab holds fewer than `--max-per-tab` (4)
panes the worker splits into it — always cutting the largest pane, with the direction
taken from its aspect ratio, so four workers form a 2x2 grid — and past that each
worker gets its own labelled tab.

```
worker 1-3  ->  split      area 251x62  ->  126x31  126x31
worker 4-6  ->  own tab                     125x31  125x31
```

`--placement auto|split|tab` overrides it.

Tabs and panes are labelled by what makes the task *different* from its siblings —
shared prefixes and words most siblings repeat are dropped, cuts land on word
boundaries, and colliding labels widen until they separate. With thirty workers the
tab bar is the only overview a person gets, and it only works if the labels differ:

```
raw truncation            distinctive label
Dolly Parton's FINAL GO   FINAL GOODBYE…
Dolly Parton's Family C   Family Cry At…
Dolly Parton's Funeral    Funeral — What Cher…
```

### Where cbds deliberately differs: the protocol lives in the skill, not the dispatch

Orca re-injects its full ~1700-token preamble on every dispatch. Herdr's own mesh
does the opposite: the receiver has the skill installed, so a message is just the
message plus a correlation id. cbds follows the mesh model.

`--contract auto` (default) checks whether the target agent kind has the cbds skill
installed and sends accordingly:

| | contract | ~tokens |
|---|---|---|
| skill installed | `bare` — task + one anchor line | ~25 |
| not installed | `standard` — the rules a correct report depends on | ~380 |
| on request | `minimal` / `full` | ~200 / ~1100 |

```
¡Hola! Responde con un saludo breve e indica qué modelo eres.

[cbds dispatch m1bh7q… — when done: cbds done --outcome succeeded --body "<summary>"]
```

Nothing is lost by going small: `cbds contract` prints the full protocol on demand.

### Mapping from Orca

| Orca | cbds | Herdr-native realization |
|---|---|---|
| Run — durable namespace + coordinator inbox | **Run** | `.cbds/runs/<run_id>/`. Same rule: never places workers. |
| Task — `pending → ready → dispatched → completed \| failed \| blocked` | **Task** | `tasks/<id>.json`, identical lifecycle plus `cancelled`. |
| Dispatch — one attempt, owns completion authority | **Dispatch** | `dispatches/<id>.json`, bound to a real pane id (`w1:p4`) and agent name. |
| Terminal handle (routing, not identity) | **Pane id** | Treated the same way: routing metadata. Identity is the `dispatch_id`. |
| `worker_done --task-id --dispatch-id --outcome` | **`cbds done`** | Same dual-ID rule, same exactly-once, same mandatory outcome. |
| `check --wait --timeout-ms` | **`cbds wait`** | Blocks on the durable inbox instead of a message bus. |
| Delivery / ack FIFO | **Report + cursor** | FIFO per run; a crash replays rather than loses. |
| `worker-release` / `worker-retain` | **`cbds release` / `retain`** | Transcript captured first; only cbds-created panes are closed. |
| `worker-start` | **`cbds dispatch start`** | Composes split + agent start + injection into one receipt. |
| `heartbeat` | **`cbds heartbeat --phase`** | Dispatch-scoped liveness. Never wakes a wait; surfaces on timeouts and the board. |
| `send --to dispatch:<id>` | **`cbds send --to <dispatch_id>`** | Structured mail, not prompt injection: it arrives on the worker's next `check` and cannot corrupt an in-flight turn. |
| Injected dispatch preamble | **`buildPreamble`** | Same structure: rules as comments at the point of use, TASK last, bare-shell vs agent post-report text, inapplicable sections omitted rather than softened. **But sized to the task** — see below. |
| `--retry-of` | **`--retry-of`** | The old dispatch permanently loses authority. |
| `--model` / `--effort` per launch | **`--model` / `--effort`** | Translated only for verified CLIs (claude, codex); everything else uses `--` passthrough, which Herdr forwards verbatim. |
| Decision gate | **`cbds gate`** | Coordinator-owned question that blocks a task. Enforced in `dispatch start` (exit 7 `task_gated`), not merely displayed. |
| Worktree isolation | **`--worktree new`** | Maps to `herdr worktree create`. Without it, parallel workers on one repo clobber each other. |
| Nested worker depth guard | **`CBDS_DEPTH`** | Injected per generation; refuses above `--max-depth`. |

Deliberately **not** copied: the scheduler (you choose placement and concurrency) and
the general message bus (`herdr-mesh` already fills that niche). Still missing:
federated workers across machines, and reading the agent's real transcript via hooks
rather than the terminal.

---

## Command reference

Every command supports `--help` and `--json`.

```
cbds run create|list|show|status|close|use
cbds task create|list|show|update|cancel
cbds dispatch start|list|show|cancel
cbds report list|show|ack
cbds done          # the authoritative completion signal (worker)
cbds wait          # the reliable receive primitive (orchestrator)
cbds heartbeat     # liveness + phase (worker) — never wakes a wait
cbds ask / reply   # blocking worker question, coordinator answer
cbds escalate      # pre-completion blocker (worker) — does not settle the task
cbds check / send  # coordinator -> worker follow-up mail
cbds trust         # pre-trust a directory so agents don't stall on a trust dialog
cbds contract      # the full worker protocol, pulled on demand
cbds skill status|install   # put the protocol in each agent, so dispatches go bare
cbds say / spawn / who      # plain messaging: no task, no contract, just the text
cbds nudge                  # remind workers that finished without reporting
cbds gate create|list|resolve|cancel   # coordinator decisions that block a task
cbds whoami        # worker self-check: am I really live?
cbds status        # what am I, what is live
cbds board         # live overview of tasks, states and pane ids
cbds release / retain
cbds doctor        # reconcile against the live Herdr session
```

### Exit codes

Stable contract — orchestrators branch on these.

| Code | Name | Meaning |
|---|---|---|
| 0 | ok | success |
| 1 | failure | generic runtime failure |
| 2 | usage | bad flags or missing required input |
| 3 | not found | no such run / task / dispatch / report |
| 4 | **timeout** | `wait` expired cleanly — a checkpoint, not a failure |
| 5 | **stale dispatch** | report rejected: superseded or mismatched ids |
| 6 | no herdr | Herdr unavailable (only `dispatch start` needs it) |
| 7 | conflict | already settled, run closed, circuit open, illegal transition |
| 8 | **worker vanished** | the pane died before reporting — retry the attempt |
| 9 | **contract undelivered** | the agent started but sat at a dialog, so it never received the task. The dispatch is NOT recorded as live. |

`4` and `8` are deliberately distinct. A timeout means *keep waiting, probably fine*; a
vanish means *this attempt is dead, retry it*. Conflating them is exactly what makes
naive orchestration loops either hang forever or give up too early.

---

## State on disk

Default: `<project root>/.cbds/`. Override with `--state-dir`, `$CBDS_STATE_DIR`, or
`--global` for `$XDG_STATE_HOME/cbds/<project>/`.

```
.cbds/
  VERSION                     # store format, checked on every open
  active-run                  # the run bound to this project
  runs/<run_id>/
    run.json
    tasks/tsk_*.json
    dispatches/dsp_*.json
    inbox/0000007-dsp_….json  # accepted reports, FIFO by sequence
    inbox/rejected/…          # rejected reports — kept, never discarded
    cursor.json               # ack position
    transcripts/dsp_*.txt     # captured at release, outlives the pane
    events.log                # append-only audit of every transition
```

Everything is versioned JSON you can read with `cat` and `jq`. Writes are
write-temp + `fsync` + `rename`, so a reader never sees a half-written file; mutations
take an atomic `mkdir` lock with stale-lock breaking; readers never lock.

## Failure and recovery

| Failure | cbds behaviour |
|---|---|
| Agent starts at a trust/approval dialog | `dispatch start` exits `9` `contract_undelivered`, the dispatch is **not** left live, and the pane cbds created is closed so nothing keeps holding the agent name. Prevent it with `--trust`. |
| A pane outlives a failed launch | `cbds doctor --fix` finds it (`zombie_pane`) and closes it. Keep it for debugging with `--keep-pane-on-failure`. |
| Worker never reports | `wait` exits `4` with elapsed time and last hint. Keep using rolling waits. |
| Pane closed mid-flight | `wait` exits `8`. Dispatch → `abandoned`; **task stays `dispatched`** — cbds does not know whether the work landed. |
| Worker reports twice | Second rejected `already_settled` (exit `7`). The first stands; replay is safe. |
| A superseded retry reports | Rejected `stale_dispatch` (exit `5`), filed under `inbox/rejected/`. Task untouched. |
| Missing `--outcome` | Exit `2`. Never inferred from prose. |
| Orchestrator crashes mid-wait | Nothing lost. Cursor unadvanced; the next `wait` returns the report instantly. |
| Herdr restarts | `cbds doctor --fix` reconciles dead panes. Durable state untouched. The plugin's `[[startup]]` hook does this automatically. |
| Herdr entirely down | `dispatch start` exits `6`. `done` / `wait` / `report` keep working. |
| Task fails 3× | Circuit opens: `task_circuit_open` (exit `7`). Raise `--max-attempts` explicitly. |
| Corrupt JSON | Quarantined to `*.corrupt` and reported loudly, never read as garbage. |

## Troubleshooting

**`cbds: command not found` in a worker pane.**
`dispatch start` puts the shim dir on the worker's PATH, so this means the pane was not
created by cbds. Check `cbds whoami`. (This is why cbds ships a real `bin/cbds`
executable rather than telling workers to run `$CBDS_BIN`: in fish and other non-POSIX
shells a variable holding `node /path/x.mjs` does not word-split, and the contract
command would silently fail.)

**`wait` returns 4 forever.**
That is a checkpoint, not a failure. Confirm the worker is alive with
`cbds board` or `herdr agent read <name>`. If the pane is gone, run `cbds doctor --fix`.

**A worker says it finished but the task is not completed.**
Run `cbds report list --rejected`. A `stale_dispatch` rejection means the work was done
but its dispatch had been superseded — the *reporting path* was stale, not the work.

**`ambiguous_run`.**
Two open runs. Pass `--run <id>`, or bind one with `cbds run use <run_id>`.

**Everything looks stuck after a Herdr restart.**
`cbds doctor --fix --break-locks`.

## Platform notes

| | Linux | macOS | Windows |
|---|---|---|---|
| State, atomic rename, lock | ✅ | ✅ | ✅ |
| `fs.watch` wake | inotify | FSEvents | ReadDirectoryChangesW |
| Safety poll (correctness floor) | ✅ | ✅ | ✅ |
| Herdr pane/agent control | ✅ | ✅ | ✅ |

The manifest invokes `node` explicitly for the board pane: Herdr documents that pane
commands do **not** get Windows `PATHEXT` shim resolution, so a bare `cbds` there would
work on Unix and fail on Windows.

## Development

```bash
npm test              # 22 tests, no Herdr required
herdr plugin link "$PWD"
herdr plugin action invoke dev.cbds.cbds.status
```

Skill file: [skills/cbds/SKILL.md](skills/cbds/SKILL.md). See [DESIGN.md](DESIGN.md) for the full design: Orca mapping, data model, preamble
contract, storage layout and the invariants the implementation must hold.

## License

MIT
