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
| `--retry-of` | **`--retry-of`** | The old dispatch permanently loses authority. |
| Nested worker depth guard | **`CBDS_DEPTH`** | Injected per generation; refuses above `--max-depth`. |

Deliberately **not** copied: the scheduler (you choose placement and concurrency), the
general message bus (`herdr-mesh` already fills that niche), and worktree management
(`herdr worktree` is better than anything cbds would add).

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

See [DESIGN.md](DESIGN.md) for the full design: Orca mapping, data model, preamble
contract, storage layout and the invariants the implementation must hold.

## License

MIT
