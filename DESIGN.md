# cbds — Design Document

> **cbds** — Reliable multi-agent orchestration for the Herdr herd.
>
> Status: design v1, targeting Herdr `>= 0.8.0` (developed against 0.8.2, socket protocol 20).

---

## 1. The problem, stated precisely

Herdr can already *send* work to another agent. `herdr pane split`, `herdr agent start`
and `herdr agent prompt` are solid, well-designed primitives. What Herdr does not give an
orchestrator is a **reliable way to receive the answer**.

Today an orchestrator that wants a result has four options, and all four are bad:

| Approach | Why it breaks |
|---|---|
| `herdr agent wait --until idle` | `idle`/`done` is a *lifecycle* state, not a *turn* result. An agent that pauses to think, prints a plan, or finishes a sub-step reads as settled. `unknown` explicitly "does not prove completion" (Herdr's own skill file says so). |
| `herdr agent read` + parse the screen | Racy. Agents on the alternate screen lose scrollback entirely — Herdr documents that rows leaving the alt screen never enter host scrollback, so a larger `--lines` cannot recover them. |
| `herdr pane wait-output --match "DONE"` | A sentinel in the transcript is unauthenticated: any echo, any retry, any quoted instruction matches it. It cannot distinguish attempt #1 from attempt #2. |
| Keep a shell blocked on the worker | The result exists only inside that process. Orchestrator crash, detach, or Herdr restart destroys it. |

The common failure is that **the result lives in the terminal**. A terminal is a rendering
surface, not a datastore.

Orca solved this with a completion *contract*: the worker makes an authoritative,
ID-matched call that mutates durable state, and the coordinator reads that state. cbds
brings the same contract to Herdr, natively.

**The one-sentence thesis:** *the transcript is a hint; the durable report is the truth.*

---

## 2. Orca → cbds concept mapping

Every Orca concept gets an idiomatic Herdr-native equivalent. Nothing is imported by
reference: cbds has no dependency on Orca, Firstmate, or any external ADE.

| Orca | cbds | Herdr-native realization |
|---|---|---|
| Run — durable namespace + coordinator inbox, "never schedules or places workers" | **Run** | A directory under `.cbds/runs/<run_id>/`. Same rule: a Run is a namespace and an inbox. It never places panes. |
| Task — work item, `pending → ready → dispatched → completed \| failed \| blocked` | **Task** | `tasks/<task_id>.json`. Identical six-state lifecycle, plus `cancelled` for operator abort. |
| Dispatch — "one attempt of a task on a terminal", owns completion authority | **Dispatch** | `dispatches/<dispatch_id>.json`, bound to a concrete Herdr **pane id** (`w1:p3`) and live **agent name**. Owns completion authority exactly as in Orca. |
| Terminal handle (routing metadata, not identity) | **Pane id + agent name** | Herdr pane ids are opaque stable handles. cbds treats them the same way Orca treats handles: *routing metadata*, never durable identity. Identity is the `dispatch_id`. |
| `worker_done` message with `--task-id --dispatch-id --outcome` | **`cbds done`** | Writes an atomic report into the Run inbox. Same dual-ID rule, same exactly-once semantics, same mandatory `--outcome`. |
| `check --wait --types worker_done --timeout-ms` | **`cbds wait`** | Blocks on the durable inbox, woken by a filesystem watch. Mandatory timeout. Returns the report, not a screen scrape. |
| Delivery / ack FIFO | **Report + `--ack` cursor** | Reports are consumed in FIFO order per Run and acknowledged by id, so a crashed orchestrator replays instead of losing mail. |
| `worker-release` / `worker-retain` | **`cbds release` / `cbds retain`** | `release` closes only the exact pane owned by a *settled* dispatch (`herdr pane close`), after preserving its transcript. `retain` records an explicit human exception. |
| `worker-start` (composed worktree+terminal+dispatch) | **`cbds dispatch start`** | Composes `herdr pane split` → `herdr agent start` → preamble injection → dispatch record, returning one receipt. |
| `dispatch --inject` (low-level, unsupervised) | **`cbds dispatch start --pane <id>`** | Attach to a pane the operator already made. Recorded as `supervised: false`; `release` will not close it. |
| `--retry-of <dispatchId>` | **`cbds dispatch start --retry-of <id>`** | New dispatch, same task. The old dispatch becomes `superseded` and **permanently loses completion authority**. |
| Escalation / question / `ask` | **`cbds ask`** (v1.1, out of scope for v1) | v1 ships `blocked` as a terminal outcome carrying a question; a full blocking ask/reply loop is deliberately deferred. |
| Decision gate | *not in v1* | Deliberately omitted. A gate is coordinator-side scheduling policy, and cbds v1 stays a completion-contract layer, not a scheduler. |
| Nested worker depth guard | **`CBDS_DEPTH`** | Injected into the worker env and incremented per generation; `dispatch start` refuses above `--max-depth` (default 1) with `nested_depth_exceeded`. |
| Agent status hooks | **hint channel only** | Herdr `pane_agent_status_changed`, `pane_closed`, `pane_exited` are consumed **strictly as hints** — they can make a wait fail *fast*, never mark a task *complete*. |

### What cbds deliberately does **not** copy

- **No scheduler.** Orca is explicit that a Run never places workers; cbds keeps that and
  goes further by shipping no coordinator loop at all. The orchestrating agent decides
  placement and concurrency.
- **No message bus.** Orca's general `send`/`reply`/group-address layer is a separate
  concern. cbds v1 has exactly one message type that matters — the completion report — and
  refuses to grow a chat system around it. `herdr-mesh` already occupies that niche.
- **No worktree management.** `herdr worktree` already exists and is better than anything
  cbds would add. `dispatch start --cwd` is the whole integration surface.

---

## 3. Architecture

```
                    orchestrator agent (any pane, may die and come back)
                            │
              cbds dispatch start ──────────────┐
                            │                   │  herdr pane split --env CBDS_*
                            │                   │  herdr agent start <name> --kind <k>
                            │                   │  herdr agent prompt <preamble+spec>
                            ▼                   ▼
                  ┌──────────────────┐    ┌──────────────────────┐
                  │  .cbds/ (truth)  │    │  Herdr pane w1:p4    │
                  │                  │    │  worker agent        │
                  │  runs/<id>/      │    │  env: CBDS_TASK_ID   │
                  │    run.json      │    │       CBDS_DISPATCH  │
                  │    tasks/*.json  │    └──────────┬───────────┘
                  │    dispatches/*  │               │
                  │    inbox/*.json  │◀──────────────┘  cbds done
                  │    cursor.json   │       (atomic write, O_EXCL)
                  └────────┬─────────┘
                           │  fs.watch (inotify / FSEvents / RDCW)
                           │  + safety poll  + mandatory timeout
                           ▼
                     cbds wait  ──▶ report JSON to the orchestrator
```

### The three properties that make this reliable

**1. The signal is durable before it is delivered.**
`cbds done` returns success only after the report is `fsync`-ed and atomically renamed
into the inbox. If the orchestrator is dead, detached, or Herdr has restarted, the report
simply sits on disk. A `cbds wait` started an hour later returns it *immediately*. This is
the property that removes the need to keep a shell alive purely to catch a result.

**2. The signal is authenticated by dual ID against live state.**
A report is accepted only when `task_id` **and** `dispatch_id` both resolve, the dispatch
belongs to that task, and the dispatch is still the task's **live** dispatch. A superseded
retry, a replayed command from scrollback, or a confused agent quoting an old preamble is
rejected with `stale_dispatch` — and the rejection is *recorded*, never silently dropped,
so the orchestrator can see that a zombie worker tried to report.

**3. Waking is a hint; correctness is a re-read.**
`fs.watch` is unreliable by nature (coalesced events, NFS, containers, Windows semantics).
cbds therefore never trusts it: every wake — from the watcher, from the safety poll, or
from a Herdr pane-death hint — triggers a full re-scan of the durable inbox. Losing every
notification degrades latency to the poll interval; it can never lose a result.

### Why not use Herdr's own event bus for the done signal?

Herdr's `events.subscribe` / `events.wait` accept a **closed set** of built-in events
(`pane_closed`, `pane_agent_status_changed`, `pane_output_matched`, …). There is no custom
event injection, and events are not durable across a server restart. They are therefore
structurally unfit to carry an authoritative completion signal — but they are *excellent*
as a liveness hint, which is exactly the role cbds gives them.

---

## 4. Data model

Storage is versioned JSON, one file per entity, human-readable and hand-editable in a
pinch. Every file carries `schema_version`.

### 4.1 Run

`runs/<run_id>/run.json`

```jsonc
{
  "schema_version": 1,
  "kind": "run",
  "run_id": "run_01k5m2p9",
  "objective": "Ship the billing audit",
  "state": "open",                 // open | closed
  "project_root": "/home/zakra/Projects/app",
  "created_at": "2026-08-30T14:22:03.114Z",
  "closed_at": null,
  "created_by": { "pane_id": "w1:p1", "agent": "claude", "host": "zakra-pc" },
  "labels": { "sprint": "42" }
}
```

### 4.2 Task

`runs/<run_id>/tasks/<task_id>.json`

```jsonc
{
  "schema_version": 1,
  "kind": "task",
  "task_id": "tsk_01k5m2q4",
  "run_id": "run_01k5m2p9",
  "title": "Fix footer overlap on mobile",
  "spec": "The footer overlaps the CTA below 380px …",
  "state": "dispatched",           // pending|ready|dispatched|completed|failed|blocked|cancelled
  "deps": ["tsk_01k5m2q0"],        // task ids that must be `completed` first
  "parent_id": null,
  "priority": 0,
  "attempts": 1,
  "max_attempts": 3,               // circuit-breaker, mirrors Orca's 3-failure rule
  "live_dispatch_id": "dsp_01k5m2r7",   // ← completion authority points here
  "dispatch_ids": ["dsp_01k5m2r7"],
  "result": null,                  // populated from the accepted report
  "created_at": "…", "updated_at": "…"
}
```

`state` is **derived and enforced**, never free-set. Legal transitions:

```
pending ──(deps satisfied)──▶ ready ──(dispatch start)──▶ dispatched
                                ▲                            │
                                │                            ├──(report succeeded)──▶ completed  [terminal]
                                └──(retry / dispatch fails)──┤
                                                             ├──(report failed)─────▶ failed
                                                             ├──(report blocked)────▶ blocked
                                                             └──(cancel)────────────▶ cancelled [terminal]

failed  ──(dispatch start --retry-of)──▶ dispatched          (while attempts < max_attempts)
blocked ──(task update --state ready)──▶ ready
```

`completed` and `cancelled` are terminal. `failed` is terminal *for the dispatch* but the
task is retryable until `attempts == max_attempts`, at which point it circuit-breaks and
further `dispatch start` returns `task_circuit_open`.

### 4.3 Dispatch

`runs/<run_id>/dispatches/<dispatch_id>.json`

```jsonc
{
  "schema_version": 1,
  "kind": "dispatch",
  "dispatch_id": "dsp_01k5m2r7",
  "task_id": "tsk_01k5m2q4",
  "run_id": "run_01k5m2p9",
  "attempt": 1,
  "retry_of": null,
  "state": "dispatched",   // starting|dispatched|settled|superseded|abandoned
  "authority": true,       // false once superseded — the whole point of the dual-ID check

  "target": {
    "pane_id": "w1:p4",           // real Herdr pane id
    "workspace_id": "w1",
    "tab_id": "w1:t1",
    "agent_name": "cbds-tsk01k5m2q4-a1",
    "agent_kind": "claude",
    "cwd": "/home/zakra/Projects/app",
    "supervised": true            // false when attached to an operator-owned pane
  },

  "preamble_sha256": "9f2c…",     // exactly what the worker was told, auditable
  "outcome": null,                // succeeded | failed | blocked
  "report_id": null,
  "hints": [                      // Herdr events — advisory only, never authoritative
    { "at": "…", "kind": "agent_status", "value": "working" }
  ],
  "started_at": "…", "settled_at": null,
  "released": false, "retained": false
}
```

### 4.4 Report (the authoritative record)

`runs/<run_id>/inbox/<seq>-<dispatch_id>.json`, written `O_EXCL` + `fsync` + atomic rename.

```jsonc
{
  "schema_version": 1,
  "kind": "report",
  "report_id": "rpt_01k5m2z1",
  "seq": 7,                        // monotonic per run, gives FIFO
  "run_id": "run_01k5m2p9",
  "task_id": "tsk_01k5m2q4",
  "dispatch_id": "dsp_01k5m2r7",
  "outcome": "succeeded",          // succeeded | failed | blocked   (REQUIRED)
  "subject": "Footer overlap fixed",
  "body": "Clamped the CTA to a min-height …",
  "files_modified": ["src/Footer.tsx"],
  "artifacts": [],                 // optional paths to fuller reports
  "next_steps": null,
  "question": null,                // set when outcome == blocked
  "reported_at": "2026-08-30T14:41:55.802Z",
  "reported_from": { "pane_id": "w1:p4", "host": "zakra-pc", "pid": 44121 },
  "acceptance": {                  // stamped by the accepting writer
    "accepted": true,
    "reason": null,                // e.g. "stale_dispatch" | "unknown_dispatch"
    "at": "…"
  },
  "acked_at": null
}
```

Rejected reports are stored identically with `accepted: false` in
`inbox/rejected/`. They are visible to `cbds report list --rejected` and never affect task
state. **Nothing is ever silently discarded.**

### 4.5 Cursor

`runs/<run_id>/cursor.json` — `{ "schema_version": 1, "acked_seq": 6 }`.
`cbds wait` returns reports with `seq > acked_seq`; `--ack <report_id>` advances it. A
crash between "returned" and "acked" replays the report, which is the safe direction.

---

## 5. State layout on disk

Resolution order for the state root:

1. `$CBDS_STATE_DIR` if set (absolute).
2. `<project_root>/.cbds/` where `project_root` is the nearest ancestor containing `.git`,
   else `$PWD` — **the default**, because it makes state visible, greppable and disposable.
3. `--global` flips to `$XDG_STATE_HOME/cbds/<slug>-<sha256(project_root)[0:8]>/`
   (`%LOCALAPPDATA%\cbds\` on Windows, `~/Library/Application Support/cbds/` on macOS) for
   repos where a stray directory is unwelcome.

```
.cbds/
  VERSION                       # "1" — store format, checked on every open
  config.json                   # defaults: poll_ms, agent kind, max_depth
  active-run                    # text file: the bound run id for this project
  runs/
    run_01k5m2p9/
      run.json
      tasks/tsk_*.json
      dispatches/dsp_*.json
      inbox/
        0000001-dsp_01k5m2r7.json
        rejected/…
      cursor.json
      seq.lock/                 # lock *directory* — mkdir is atomic everywhere
      transcripts/dsp_*.txt     # captured on release, so output outlives the pane
      events.log                # append-only audit: every state transition, one JSON per line
```

**Concurrency.** Multiple workers report simultaneously; multiple orchestrators may read.

- **Inbox writes** need no lock: the sequence number is claimed by `mkdir seq.lock/`
  (atomic on POSIX and Windows), incremented, released. The report file itself is written
  to a temp name then `rename()`d — atomic and never observed half-written.
- **Entity mutation** (task/dispatch state) takes the same lock directory, with stale-lock
  breaking after 30 s based on the recorded pid+host+mtime.
- **Readers never lock.** They tolerate a missing file (mid-rename) by retrying once.

`events.log` is append-only with `O_APPEND` writes under the POSIX atomic-append size, so
the audit trail survives even a torn concurrent write.

---

## 6. The preamble contract

This is the text injected into the worker. It is **agent-agnostic**: it assumes only a
shell and the `cbds` binary, so it works identically for claude, codex, opencode, pi, grok,
hermes, gemini, cursor, droid, amp, kiro, qwen and every future Herdr kind.

Belt **and** braces: the identity is delivered *twice* — once in the pane environment
(machine-readable, survives scrollback loss, immune to paraphrase) and once in prose
(so the agent understands the obligation).

```
━━━ CBDS DISPATCH ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are a cbds worker. A coordinator is blocked waiting for your report.

  run_id      run_01k5m2p9
  task_id     tsk_01k5m2q4
  dispatch_id dsp_01k5m2r7

TASK — Fix footer overlap on mobile
<the full spec, verbatim>

COMPLETION CONTRACT — non-negotiable
1. Do the task.
2. Then run EXACTLY ONE of these, from this pane's shell:

   cbds done --outcome succeeded --subject "<short>" --body "<what you did,
     what you found, what remains>" --files-modified "path/a,path/b"

   cbds done --outcome failed    --subject "<short>" --body "<why it failed>"

   cbds done --outcome blocked   --subject "<short>" --question "<what you need>"

3. Send it EXACTLY ONCE, including on failure. Never encode failure only in prose.
4. Then stop and idle at your prompt. Do not start new work, do not poll,
   do not close this pane.

Your identity is already in this pane's environment
(CBDS_RUN_ID / CBDS_TASK_ID / CBDS_DISPATCH_ID), so the ids above are
optional — `cbds done --outcome succeeded --body "…"` is enough.
If you ever need them explicitly, pass --task-id and --dispatch-id.

Verify at any time with:  cbds whoami
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The exact bytes are hashed into `preamble_sha256` so the orchestrator can prove what the
worker was told. `cbds dispatch show --preamble` reprints it verbatim.

**Injected environment** (via `pane.split --env`, inherited by the agent process):

| Var | Purpose |
|---|---|
| `CBDS_RUN_ID` / `CBDS_TASK_ID` / `CBDS_DISPATCH_ID` | implicit identity for `cbds done` |
| `CBDS_STATE_DIR` | absolute state root, so `done` works from any cwd |
| `CBDS_DEPTH` | nesting guard |
| `CBDS_ROLE=worker` | makes `cbds whoami` and the skill unambiguous |

**Anti-forgery.** Because identity comes from the environment of a pane that only cbds
created, an agent cannot accidentally complete someone else's task by pasting a stale
command — the dual-ID check against `live_dispatch_id` rejects it.

---

## 7. Command surface

Global flags on every command: `--json` (stable machine envelope), `--run <id>`,
`--state-dir <path>`, `--no-color`, `--quiet`, `-h/--help`.

Every command that can block takes a **mandatory-by-default** `--timeout <ms>`; there is no
infinite wait anywhere in cbds.

```
cbds run create   --objective <text> [--label k=v]... [--bind] [--json]
cbds run list     [--state open|closed] [--json]
cbds run show     [<run_id>] [--json]
cbds run status   [<run_id>] [--json]          # aggregate task/dispatch counts
cbds run close    [<run_id>] [--force] [--json]
cbds run use      <run_id>                     # bind the active run for this project

cbds task create  --spec <text> [--title <t>] [--deps <id,id>] [--parent <id>]
                  [--priority <n>] [--max-attempts <n>] [--json]
cbds task list    [--state <s>] [--ready] [--brief] [--json]
cbds task show    <task_id> [--json]
cbds task update  <task_id> [--state <s>] [--spec <t>] [--title <t>]
                  [--deps <ids>] [--result <json>] [--json]
cbds task cancel  <task_id> [--reason <text>] [--json]

cbds dispatch start   --task <task_id>
                      [--agent <kind>]          # default from config, else `claude`
                      [--pane <pane_id>]        # attach to an existing pane (unsupervised)
                      [--direction right|down]  # default: chosen from `herdr pane layout`
                      [--cwd <path>] [--workspace <w>] [--tab <t>]
                      [--name <agent-name>] [--retry-of <dispatch_id>]
                      [--no-focus] (default) [--focus]
                      [--startup-timeout <ms>]  # default 60000
                      [--max-depth <n>] [--dry-run] [--json]
cbds dispatch list    [--task <id>] [--state <s>] [--json]
cbds dispatch show    <dispatch_id> [--preamble] [--hints] [--json]
cbds dispatch cancel  <dispatch_id> [--json]    # supersede without settling the task

cbds done   [--task-id <id>] [--dispatch-id <id>]        # implicit from env
            --outcome succeeded|failed|blocked
            [--subject <text>] [--body <text>] [--body-file <path>]
            [--files-modified <csv>] [--artifact <path>]...
            [--question <text>] [--next-steps <text>] [--json]

cbds wait   [--task <id>] [--dispatch <id>] [--run <id>]   # scope; default = active run
            --timeout <ms>                                  # MANDATORY
            [--outcome <csv>] [--ack <report_id>] [--any|--all]
            [--poll <ms>] [--no-hints] [--json]

cbds status [--json]                       # what am I? what is live? one screen
cbds whoami [--json]                       # worker identity self-check
cbds report list  [--task <id>] [--rejected] [--unacked] [--json]
cbds report show  <report_id> [--json]
cbds report ack   <report_id> [--json]

cbds release <dispatch_id> [--force] [--json]   # settled only; captures transcript, closes pane
cbds retain  <dispatch_id> [--reason <t>] [--json]

cbds board  [--once] [--interval <ms>] [--json]  # live overview; also the plugin pane
cbds doctor [--json]                             # herdr reachable? state sane? locks stale?
```

### Exit codes (stable contract)

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | generic runtime failure |
| `2` | usage error (bad flags) — matches Herdr's own convention |
| `3` | not found (run/task/dispatch/report) |
| `4` | **timeout** — `cbds wait` expired cleanly with no matching report |
| `5` | **stale or mismatched dispatch** — report rejected |
| `6` | Herdr unavailable (no socket / not inside a Herdr pane when required) |
| `7` | conflict — already settled, run closed, circuit open, illegal transition |
| `8` | **worker vanished** — hint channel proved the pane died before reporting |

`4` and `8` are deliberately distinct: a timeout means *keep waiting, probably fine*; a
vanish means *this attempt is dead, retry it*. Conflating them is what makes naive
orchestration loops either hang forever or give up too early.

### `cbds wait` semantics in detail

1. Resolve scope → the set of dispatch ids whose reports would satisfy this wait.
2. **Scan first.** Reports already on disk satisfy the wait *immediately*. This is what makes
   a late-starting `wait` correct after an orchestrator crash.
3. Otherwise arm three sources and block:
   - `fs.watch` on `inbox/` (sub-second, best-effort);
   - a safety poll every `--poll` ms (default 2000, clamped `[250, 30000]`);
   - the **hint channel**: a child `herdr` process on `events.wait` for `pane_closed` /
     `pane_exited` on the dispatch's pane, plus `pane_agent_status_changed`.
4. Any wake → full re-scan of the durable inbox. Only a durable report resolves the wait.
5. A pane-death hint with no report on disk → exit `8` `worker_vanished`, **task left
   `dispatched`, not failed** — the orchestrator decides whether to retry.
6. Timeout → exit `4`, and print how long the dispatch has been running plus its last hint,
   so a rolling wait loop is informative rather than blind.
7. `--all` waits for every in-scope dispatch to settle; `--any` (default) returns the first.

---

## 8. Herdr integration surface

cbds shells out to the Herdr CLI via `$HERDR_BIN_PATH` (falling back to `herdr` on PATH),
which the plugin docs prescribe as the portable invocation. Every call is JSON-parsed, has
a timeout, and maps Herdr's `{"error":{"code","message"}}` onto a cbds exit code.

| cbds operation | Herdr call |
|---|---|
| create worker pane | `pane split --direction <d> --cwd <p> --env CBDS_*=… --no-focus` |
| pick a direction | `pane layout --pane $HERDR_PANE_ID` → wide splits right, tall splits down |
| start the agent | `agent start <name> --kind <k> --pane <id> --timeout <ms>` |
| inject the task | `agent prompt <name> <preamble> --wait --timeout <ms>` |
| liveness hint | `events.wait` on `pane_closed` / `pane_exited` / `pane_agent_status_changed` |
| paint the sidebar | `pane report_metadata --state-labels cbds=<state> --tokens task=<id>` |
| capture transcript | `agent read <name> --source recent-unwrapped --lines 2000` before release |
| close on release | `pane close <id>` — only for `supervised: true` dispatches |

**Sidebar observability.** `pane.report_metadata` accepts `state_labels`, `tokens` and a
`ttl_ms`. cbds paints each worker pane with its task id and dispatch state, so the human
sees cbds state in the native Herdr UI without opening the board. This is what makes cbds
feel like part of Herdr rather than a bolt-on.

**cbds never requires Herdr for the completion path.** `done`, `wait`, `report` and the
whole state model are pure filesystem. If the Herdr server is down, reports still land and
still resolve waits. Herdr is required only to *place* a worker.

---

## 9. Plugin manifest outline

```toml
id = "dev.cbds.cbds"
name = "cbds"
version = "1.0.0"
min_herdr_version = "0.8.0"
description = "Reliable multi-agent orchestration for the Herdr herd."
platforms = ["linux", "macos", "windows"]

# No [[build]]: cbds is zero-dependency Node ESM, so `plugin install` needs no
# network, no npm ci, and no compile step. Nothing to go wrong at install time.

[[startup]]
command = ["node", "plugin/startup.mjs"]      # reconcile state after session restore

[[actions]]
id = "board"
title = "cbds: open board"
contexts = ["workspace", "pane"]
command = ["node", "plugin/action-board.mjs"]

[[actions]]
id = "status"
title = "cbds: run status"
contexts = ["workspace", "pane"]
command = ["node", "plugin/action-status.mjs"]

[[actions]]
id = "release-pane"
title = "cbds: release this worker"
contexts = ["pane"]
command = ["node", "plugin/action-release.mjs"]

[[panes]]
id = "board"
title = "cbds board"
placement = "split"
command = ["node", "plugin/board-pane.mjs"]

[[events]]
on = "pane.closed"
command = ["node", "plugin/event-pane-closed.mjs"]   # record a vanish hint

[[events]]
on = "pane.exited"
command = ["node", "plugin/event-pane-exited.mjs"]

[[keys.command]]
key = "prefix+b"
type = "plugin_action"
command = "dev.cbds.cbds.board"
description = "open the cbds board"
```

Installable with `herdr plugin install zqkra/cbds`, developed with
`herdr plugin link /path/to/cbds`. The `cbds` CLI is the same code, exposed via `bin/`.

---

## 10. Failure and recovery matrix

| Failure | Detection | cbds behaviour |
|---|---|---|
| Worker never reports | `wait` timeout | exit `4`, task stays `dispatched`, prints elapsed + last hint. Rolling waits are safe. |
| Pane closed mid-flight | `pane_closed` hint + `pane.get` confirm | exit `8` `worker_vanished`. Task stays `dispatched`; `dispatch.state = abandoned`. Operator retries with `--retry-of`. |
| Worker reports twice | `dispatch.state != dispatched` on 2nd | 2nd rejected `already_settled`, exit `7`. First report stands. Idempotent replay is safe. |
| Stale retry reports | `dispatch_id != task.live_dispatch_id` | rejected `stale_dispatch`, exit `5`, filed under `inbox/rejected/`. Task untouched. |
| Mismatched ids | task/dispatch cross-check | rejected `dispatch_task_mismatch`, exit `5`. |
| Missing `--outcome` | validation | exit `2`. Never inferred from prose — mirrors Orca's hardest rule. |
| Orchestrator crashes mid-wait | — | Nothing lost. Report is on disk; cursor unadvanced; next `wait` returns it instantly. |
| Herdr server restarts | pane ids may be stale | `cbds doctor` reconciles: pane gone → dispatch `abandoned` + hint recorded. Durable state is untouched. |
| Herdr entirely down | `pane split` fails | `dispatch start` exits `6` with a clear message. `done`/`wait`/`report` keep working. |
| Two orchestrators, one run | FIFO cursor + lock dir | Reports are consumed once; the loser sees the advanced cursor. No double-processing. |
| Stale lock (killed process) | pid+host+mtime > 30 s | Broken automatically, logged to `events.log`. |
| Corrupt/partial JSON | parse guard | File quarantined to `*.corrupt`, logged, operation fails loudly rather than reading garbage. |
| Task fails 3× | `attempts == max_attempts` | Circuit opens: `task_circuit_open`, exit `7`. Requires explicit `task update --max-attempts`. |

---

## 11. Cross-platform position

| | Linux | macOS | Windows |
|---|---|---|---|
| State, atomic rename, lock dir | ✅ | ✅ | ✅ |
| `fs.watch` wake | inotify | FSEvents | ReadDirectoryChangesW |
| Safety poll (correctness floor) | ✅ | ✅ | ✅ |
| Herdr pane/agent control | ✅ | ✅ | ✅ (via `HERDR_BIN_PATH`) |
| `[[panes]]` board command | ✅ | ✅ | ⚠️ Herdr documents that pane commands do **not** get `PATHEXT` shim resolution, so the manifest invokes `node` explicitly rather than a `.cmd` shim. |

The only real asymmetry is the documented Windows pane-command shim gap, and invoking
`node` directly sidesteps it. Everything else is Node built-ins.

---

## 12. Design rules the implementation must hold

1. **No silent hangs.** Every blocking call has a timeout; every timeout has its own exit code.
2. **No screen scraping on the happy path.** Transcript reads exist only for `release`
   capture and human debugging.
3. **The report is the truth.** No Herdr event, agent status, or terminal string may ever
   move a task to `completed`.
4. **Nothing is discarded silently.** Rejected reports are stored and listable.
5. **Reads never block writes.** Only mutations take the lock.
6. **The store is legible.** A human with `cat` and `jq` can fully understand the state.
7. **Zero runtime dependencies.** Node built-ins only, so `plugin install` cannot fail on
   a registry outage or a native build.
