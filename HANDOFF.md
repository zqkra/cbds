# cbds — handoff

**State: v2.3.0, published and working. 82 tests pass.**
Last updated 2026-08-31, written before a machine format.

- Repo: https://github.com/zqkra/cbds (public, MIT)
- Everything below is in the repo; nothing depends on the old machine.

---

## What cbds is

A native Herdr plugin + zero-dependency Node CLI that makes multi-agent orchestration
inside Herdr reliable. Herdr can *send* work to a pane; what it could not do is tell
you the work is **done**. cbds fixes the receive side with a completion contract
modelled on the reliable core of Orca's orchestration layer.

**Thesis: the transcript is a hint, the durable report is the truth.**

Two verbs, and picking the wrong one is the classic misuse:

| You want | Use |
|---|---|
| To say something (a greeting, a heads-up) | `cbds spawn` / `cbds say` — the other agent receives exactly your text |
| A structured result you will block on | `cbds dispatch start` + `cbds wait` |

---

## Restore on a fresh machine

```bash
# 1. Herdr itself
paru -S herdr-bin                      # AUR, was 0.8.2
herdr integration install claude       # and codex, etc.

# 2. cbds
git clone https://github.com/zqkra/cbds ~/Projects/cbds
herdr plugin install zqkra/cbds        # or: herdr plugin link ~/Projects/cbds
ln -sf ~/Projects/cbds/bin/cbds ~/.local/bin/cbds

# 3. The worker protocol, into every agent (THIS IS WHAT MAKES DISPATCHES CHEAP)
cbds skill install                     # claude, codex, opencode, pi, gemini, grok
cbds skill status                      # verify

# 4. Sanity
cbds doctor
npm test                               # 82 tests, no Herdr needed
```

Note: `cbds skill install` deliberately does NOT write `~/.agents/skills` by default —
agents that read both their own dir and that one print a duplicate-skill warning (pi
shows a "cbds collision" banner). Add `--agent universal` only if you want it.

---

## The loop

```bash
cbds run create --objective "<what this run is for>"
cbds task create --spec "<the work, in full>" --title "<short label>"
cbds dispatch start --task <id> --agent claude --trust
cbds wait --task <id> --timeout 900000
cbds release <dispatch_id>
```

Worker side, exactly once, even on failure:

```bash
cbds done --outcome succeeded --subject "<one line>" --body "<did / found / remains>"
```

---

## Hard-won lessons — do not relearn these

Each one cost a real failure. Full detail in `git log` and in the memory vault under
`Projects/cbds/decisions.md`.

1. **`$VAR` holding `node /path/x.mjs` breaks in fish.** Worker panes inherit the
   user's shell; fish does not word-split variables, so the contract command silently
   became "command not found". Fixed by shipping a real single-word executable
   (`bin/cbds`) and injecting its dir onto the worker's PATH.

2. **Not everything `herdr` prints is JSON.** `pane read`, `agent read` and `status`
   return plain text. `herdr agent` prints its group listing to **stderr** and exits 2.

3. **`herdr agent get` answers `{type, agent:{...}}`** — reading `.name` off the
   envelope silently gives undefined. It made every dispatch record a nameless
   coordinator for a while.

4. **`HERDR_PLUGIN_CONTEXT_JSON` uses FLAT keys** (`focused_pane_cwd`,
   `focused_pane_id`), not nested. The nested assumption failed silently onto the
   plugin root.

5. **`herdr <group> <sub> --help` prints GLOBAL help.** The group listing is the real
   documentation, and `herdr api schema` (91 socket methods) is authoritative. That is
   how `pane split --env` and `tab create --env` were found — both load-bearing.

6. **An AbortController latches.** Reusing one after a spurious event made every
   subsequent wait return instantly, forever.

7. **A failed launch must not leave a zombie pane.** It holds the Herdr agent name, so
   the retry dies with `agent_start_failed` and `doctor` reported "nothing to report".
   Agent names now derive from the dispatch id (unique by construction), not the
   attempt number, which only increments once a dispatch commits.

8. **Directory-trust dialogs are the #1 reason a worker never starts.** claude and
   codex gate on them; a fresh git worktree hits it every time. `cbds trust` or
   `dispatch start --trust`. An undelivered contract now fails loudly (exit 9) instead
   of leaving a dispatch that looks live.

9. **Writing a summary is not reporting — this was the worst one.** A worker did the
   work, ran 151 tests, printed its findings on its own screen prefixed "Important for
   the orchestrator:", and went idle. Its spec ended with a `# Al reportar` section and
   a small model read that as "write prose". The rule is now stated in those exact
   terms in the preamble and at the very top of the skill.

10. **A CLI cannot push into an agent's context.** If the coordinator ends its turn
    instead of blocking on `cbds wait`, an accepted report sits unread. `cbds done` now
    delivers into the coordinator's pane when nobody is waiting; `cbds wait` registers
    itself so you are never told twice.

---

## Where it stands vs Orca

**At parity:** the completion contract (dual ID, exactly-once, mandatory `--outcome`),
heartbeat / ask / reply / escalate / check, per-worker model & effort, decision gates,
worktree isolation.

**Better:** the preamble is sized to the task (~25 tokens when the worker has the skill,
vs Orca's ~1700 every time); `worker_vanished` (exit 8) kills a dead attempt in seconds;
`contract_undelivered` (exit 9) + `cbds trust`; no IDE needed; state is `cat`-readable.

**Still missing:**
1. **Agent reuse between tasks** — every dispatch starts a fresh agent (15-20s each; on
   52 tasks that is ~16 minutes of pure boot). Orca reuses the terminal. *This is the
   highest-value thing left.*
2. **Dependency results do not travel** — task B depends on A, but A's report is not
   injected into B's dispatch. You copy it into the spec by hand today.
3. Federated workers across machines (`--on <host>`).
4. `release` reads the terminal, not the agent's real transcript via hooks.

## Not verified end-to-end

Two harnesses in parallel (claude + codex simultaneously) with ask/reply and heartbeat
in flight. Covered by tests, never run live. Every real bug in this list was found by
running, not by reading — treat that gap accordingly.
