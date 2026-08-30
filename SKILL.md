---
name: cbds
description: >-
  Use cbds for reliable multi-agent orchestration inside Herdr: dispatching tasks to
  worker panes and receiving authoritative completion reports. Use it whenever the user
  asks you to supervise, monitor, wait for, track, coordinate, or collect results from
  other agents, or to split work across several Herdr panes and report back. Do NOT use
  it for a plain handoff ("hand this to another agent", "open a pane and run X") where
  nobody is waiting for a result — use the plain `herdr` skill for that. Requires the
  `cbds` CLI and a running Herdr session.
---

# cbds

**The transcript is a hint. The durable report is the truth.**

Herdr can send work to another pane. What it cannot do reliably is tell you the work is
*done*: `agent wait --until idle` reports a lifecycle state, not a turn result; screen
reads race and lose scrollback on the alternate screen; a `DONE` sentinel in the
transcript is unauthenticated. cbds fixes the receive side with a completion contract:
the worker writes an authoritative, ID-matched report to disk, and you read it.

## When to use cbds, and when not to

Use cbds when **you are waiting for a result**:

- "supervise", "monitor", "wait for", "track completion", "collect results"
- splitting work across several agents and reporting back
- anything with a dependency order between pieces of work

Do **not** use cbds for a full handoff — "hand this off", "give this to another agent",
"open a pane and run the tests". Those transfer ownership; nobody is waiting. Use the
plain `herdr` skill: `herdr pane split` + `herdr agent start` + `herdr agent prompt`.
Creating a task and dispatch for a handoff records coordination state that no one will
ever read, and puts a reporting obligation on a worker that has no coordinator.

## Preconditions

```bash
cbds status          # role, Herdr connectivity, live runs, waiting reports — one screen
```

`cbds status` is the first thing to run in any cbds session. It answers "what am I?" and
"what is live?" and tells you the next command. If it says the store is not initialised,
create a run.

`cbds dispatch start` needs a running Herdr session. Everything else — `done`, `wait`,
`report`, `task`, `board` — is pure filesystem and works with Herdr down.

---

## Orchestrator

### The loop

```bash
cbds run create --objective "<what this run is for>"
cbds task create --spec "<the work, in full>" --title "<short label>"
cbds dispatch start --task <task_id> --agent claude
cbds wait --task <task_id> --timeout 900000
cbds release <dispatch_id>
```

Create the run and **every independent task first**, then start **all** independent
workers, and only then start waiting. Waiting after each dispatch serialises work that
should be parallel.

```bash
cbds run create --objective "Ship the billing audit" --json
A=$(cbds task create --spec "<worker A work>" --json | jq -r .data.task_id)
B=$(cbds task create --spec "<worker B work>" --json | jq -r .data.task_id)
cbds dispatch start --task $A --agent claude --json
cbds dispatch start --task $B --agent codex  --json
cbds wait --all --timeout 900000 --json      # both, in one blocking call
```

### Choosing the model and effort per worker

Each worker is launched independently, so you pick the right agent **and** the right
model for each piece of work. A cheap mechanical task does not need your best model.

```bash
cbds dispatch start --task <id> --agent claude --model opus --effort high
cbds dispatch start --task <id> --agent codex  --model gpt-5.5 --effort xhigh
```

`--effort` requires `--model`. cbds only translates these for CLIs it has verified
(**claude**, **codex**); for any other agent, pass its native arguments after `--`,
which Herdr forwards verbatim:

```bash
cbds dispatch start --task <id> --agent opencode -- --model <whatever that CLI takes>
```

Anything after `--` is appended last, so an explicit native argument always wins over
cbds's translation. A wrong `--model` for an unmapped agent is refused up front rather
than producing a pane that dies on a bad flag.

### Directory trust — the most common reason a worker never starts

`claude` and `codex` show a directory-trust dialog the first time they run somewhere
new. A worker parked on that dialog **never receives its task**: Herdr refuses to
prompt a blocked agent, so cbds fails the dispatch with `contract_undelivered`
(exit 9) rather than leaving you waiting on a worker that was never told what to do.

This bites every time you dispatch into a fresh git worktree. Pre-empt it:

```bash
cbds trust --check              # will any agent stall in this directory?
cbds trust                      # pre-trust the current directory
cbds trust /path/to/worktree --agent claude
cbds dispatch start --task <id> --agent claude --trust    # do it inline
```

`cbds trust` is per-directory and explicit — it writes the same record the dialog
itself would, backing up each config first. It is not a global switch, and it never
runs unless you ask for it.

If a human is at the keyboard and you would rather they answer the dialog:

```bash
cbds dispatch start --task <id> --agent claude --wait-ready 120000
```

### Waiting properly

`--timeout` is mandatory. cbds never waits forever.

**A timeout is a checkpoint, not a failure.** Real coding tasks run 15–60 minutes. On
exit 4, look at what cbds printed (elapsed time, last hint) and wait again. Do not
retry the task, do not close the pane, do not decide the worker is broken.

Distinguish the two "nothing arrived" cases — this is the whole point of the exit codes:

| Exit | Meaning | What you do |
|---|---|---|
| `0` | a report arrived | process it, then `release` |
| `4` | timeout | **keep waiting** with another rolling window |
| `8` | the worker's pane died with no report | the attempt is dead; retry with `--retry-of` |
| `9` | the agent started but never got the task (a trust/approval dialog) | `cbds trust` the directory, then retry with `--retry-of` |

```bash
cbds wait --task <task_id> --timeout 900000 --json
case $? in
  0) ;;                                  # got it
  4) ;;                                  # keep waiting — call again
  8) cbds dispatch start --task <task_id> --retry-of <dispatch_id> --agent claude ;;
esac
```

Waiting is **durable**. If your wait dies — you crash, you detach, Herdr restarts — the
report is still on disk. Run `cbds wait` again later and it returns instantly. You never
need to keep a shell alive just to catch a result.

### Scopes

```bash
cbds wait --task <task_id> --timeout 900000        # one task
cbds wait --dispatch <dispatch_id> --timeout 60000 # one attempt
cbds wait --timeout 900000 --all                   # every live dispatch in the run
cbds wait --timeout 1000                           # drain reports already on disk
```

### Answering workers mid-flight

`cbds wait` wakes on three things, not just completions: `report`, `question` and
`escalation`. Heartbeats deliberately do **not** wake it — they are liveness, not news.

```bash
cbds wait --task <task_id> --timeout 900000 --json
# -> type: "question"   the worker is BLOCKED. Answer it, then keep waiting:
cbds reply --id <message_id> --body "<answer>"

# -> type: "escalation" the worker hit a blocker but is still running and still
#                       owes you a report. Unblock it, then keep waiting.

# Send unsolicited guidance to a live worker (it arrives on its next `cbds check`):
cbds send --to <dispatch_id> --subject "heads up" --body "skip the CSS bit"
```

A question or escalation does **not** settle the task. Only a report does.

### After every report

Account for the worker before you wait again or end your turn. Exactly one of:

```bash
cbds release <dispatch_id>                     # normal: capture transcript, close pane
cbds retain  <dispatch_id> --reason "<why>"    # the user asked to keep it for debugging
cbds dispatch start --task <next_task_id> ...  # immediately reuse for follow-up work
```

Released workers stay readable: `release` writes the transcript to
`.cbds/runs/<run>/transcripts/<dispatch_id>.txt` **before** closing anything.

### Reading state

```bash
cbds board                      # live overview: tasks, states, pane ids, elapsed
cbds board --once --json        # one snapshot, machine-readable
cbds task list --ready          # what can be dispatched right now — use as external memory
cbds task show <task_id>        # spec, dispatch history, result
cbds report list --rejected     # workers that tried to report on a dead dispatch
cbds dispatch show <id> --preamble   # exactly what the worker was told
cbds doctor --fix               # reconcile after a Herdr restart or a hand-closed pane
```

Check `cbds report list --rejected` when something feels wrong. A rejected report means a
worker did the work and tried to tell you, but its dispatch had been superseded. The work
may well be fine — the *reporting path* was stale.

### Dependencies

```bash
cbds task create --spec "<work>" --deps <task_id_a>,<task_id_b>
```

A task with unmet deps is `pending` and will not appear in `--ready`. It flips to `ready`
automatically when every dep reaches `completed`. Keep chains to 3–4 steps; deeper DAGs
are usually a decomposition problem.

### Rules

- **Never mark a task completed yourself.** `cbds task update --state completed` is
  refused by design. Only an accepted report completes a task.
- **Do not release on a timeout.** Release is post-completion cleanup, not cancellation.
- **A heartbeat of terminal activity means alive, not done.** Do not stop a worker
  because it has not reported yet.
- **Do not read the worker's screen to guess progress.** If you need the answer, wait for
  the report. `agent read` is for debugging a worker you already believe is stuck.

---

## Worker

If a prompt hands you a **CBDS DISPATCH** block, you are a supervised worker and a
coordinator is blocked on you.

### First, verify you are real

```bash
cbds whoami
```

- `live cbds worker` with `authority: yes` → do the task, then report.
- `not a cbds worker`, or `authority: no` → the preamble is **stale**, inherited from
  scrollback or a handoff. **Do not report.** Tell the user.

This check exists because a preamble is just text: it can be scrolled back to, copied,
or inherited. Your environment (`CBDS_TASK_ID`, `CBDS_DISPATCH_ID`) is what actually
makes you a worker.

### While you work

```bash
cbds heartbeat --phase implementing     # every ~5 min on long work
```

The coordinator uses heartbeats to tell "still thinking" from "hung". Skip them only
while blocked inside `ask` — that call is itself a liveness signal.

**Never ask a human through your own interactive UI** — `AskUserQuestion`, a TUI
confirm, a y/n prompt. The coordinator cannot see it and cannot answer it, so you hang
forever waiting on someone who is not looking. Every interactive question goes through
`cbds ask`:

```bash
cbds ask --question "shared component or page-only?" --options "shared,page-only" --timeout 600000
# prints the coordinator's answer, then you continue.
# If it times out, resume by id — NEVER ask again, or you create a duplicate thread:
cbds ask --resume <message_id> --timeout 600000
```

If you are blocked in a way the coordinator must fix before you can continue, but you
are not asking a question:

```bash
cbds escalate --subject "Blocked: missing credentials" --body "<details>"
```

An escalation does not settle your task — you still owe exactly one report.

Read guidance the coordinator sent you:

```bash
cbds check
```

### Then, report exactly once

```bash
cbds done --outcome succeeded \
  --subject "<one line>" \
  --body "<what you did, what you found, what remains>" \
  --files-modified "src/a.ts,src/b.ts"

cbds done --outcome failed  --subject "<one line>" --body "<why, and what you tried>"

cbds done --outcome blocked --subject "<one line>" --question "<what you need>"
```

The ids come from your environment, so you never pass them. Pass `--task-id` and
`--dispatch-id` only if you need them explicit.

**Rules:**

1. **Exactly once, including on failure.** An unreported failure is indistinguishable
   from a hung worker, and it will burn the coordinator's entire timeout.
2. **`--outcome` is mandatory and is never inferred from your prose.** A body that says
   "this didn't work" with `--outcome succeeded` is a lie the system will believe.
3. **After reporting, stop.** Idle at your prompt. Do not start new work, do not poll,
   do not close your own pane. The coordinator owns cleanup.
4. **A direct instruction from the user takes precedence** and starts ordinary
   user-owned work. Do not refuse it on role grounds — but do not reuse the settled
   dispatch's ids for it either.

### Exit codes from `done`

| Exit | Meaning |
|---|---|
| `0` | accepted; the coordinator has been signalled |
| `2` | you omitted `--outcome`, or have no identity |
| `5` | **stale dispatch** — your attempt was superseded. Your work is not lost, but nobody is listening on this dispatch. Tell the user. |
| `7` | already settled — you reported twice. The first report stands. |

### Nesting

A worker cannot normally dispatch sub-workers: `cbds dispatch start` returns
`nested_depth_exceeded`. Do the task yourself rather than routing around it. Creating a
new run does not reset the depth — it is counted from your pane's `CBDS_DEPTH`.

---

## Exit codes (whole CLI)

| Code | Name | Meaning |
|---|---|---|
| 0 | ok | success |
| 1 | failure | generic runtime failure |
| 2 | usage | bad flags or missing required input |
| 3 | not found | no such run / task / dispatch / report |
| 4 | timeout | `wait` expired cleanly — a checkpoint, not a failure |
| 5 | stale dispatch | report rejected: superseded or mismatched ids |
| 6 | no herdr | Herdr unavailable (only `dispatch start` needs it) |
| 7 | conflict | already settled, run closed, circuit open, illegal transition |
| 8 | worker vanished | the pane died before reporting — retry the attempt |
| 9 | contract undelivered | the agent started but was blocked at a dialog, so it never received the task. The dispatch is NOT live. |

## Bare-shell dispatch

To track work in a pane with no agent — a script, or a human:

```bash
cbds dispatch start --task <task_id> --no-agent
```

The pane gets the full `CBDS_*` environment (and `cbds` on its PATH), so whoever works
there can still run `cbds done`. Nothing is injected, so nothing can be misdelivered.
Print the contract for them with `cbds dispatch show <dispatch_id> --preamble`.
