import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CBDS_BIN_DIR = path.resolve(HERE, '..', '..', 'bin');
export const CBDS_BIN_PATH = path.join(CBDS_BIN_DIR, 'cbds.mjs');

const onPath = (name) => {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, name + ext);
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* keep looking */ }
    }
  }
  return null;
};

const quote = (p) => (/[\s"']/.test(p) ? JSON.stringify(p) : p);

/**
 * How the worker should invoke cbds.
 *
 * This MUST be a single word. A plugin-installed cbds is not necessarily on the
 * worker's PATH, and the obvious fallback — `node /path/to/cbds.mjs` in an env var —
 * is broken by design: fish (and any non-POSIX shell) does not word-split variables,
 * so `$CBDS_BIN done ...` becomes a command named "node /path/to/cbds.mjs" and fails.
 * A worker that cannot run the command is a silent completion failure, which is the
 * exact class of bug cbds exists to eliminate.
 *
 * So cbds ships a real executable shim (bin/cbds, bin/cbds.cmd) and injects its
 * directory onto the worker's PATH. The contract command is always literally `cbds`.
 */
export const resolveCbdsCommand = () => 'cbds';

/** PATH for the worker pane, with the cbds shim dir first (deduped). */
export const workerPath = (basePath = process.env.PATH ?? '') => {
  const parts = basePath.split(path.delimiter).filter(Boolean);
  return [CBDS_BIN_DIR, ...parts.filter((p) => path.resolve(p) !== CBDS_BIN_DIR)]
    .join(path.delimiter);
};

/** True when a `cbds` executable already resolves without our injection. */
export const cbdsOnPath = () => Boolean(onPath('cbds'));

const RULE = '━'.repeat(70);

// Cadence chosen so the coordinator's staleness view catches a hung worker within a
// tick or two without turning long tasks into heartbeat spam. One constant, so
// retuning is a one-line change.
const HEARTBEAT_INTERVAL_MIN = 5;

/**
 * Build the worker preamble.
 *
 * Agent-agnostic on purpose: it assumes only a shell and the `cbds` binary, so the
 * same bytes work for claude, codex, opencode, pi, grok, hermes, gemini, cursor,
 * droid, amp, kiro, qwen and every future Herdr agent kind.
 *
 * Identity is delivered TWICE: in the pane environment (machine-readable, immune to
 * paraphrase, survives scrollback loss on the alternate screen) and in prose (so the
 * agent understands the obligation).
 *
 * The structure follows Orca's dispatch preamble, which is tuned for LLM readers:
 *
 *   1. Behavioural rules are comments ABOVE the command they govern, never a trailing
 *      prose block — models anchor on examples and skim prose that follows them.
 *   2. The TASK goes LAST, so the thing to act on is the freshest text.
 *   3. Post-report instructions differ for an agent (idle, stay reusable) and a bare
 *      shell (exit — it has no prompt for the coordinator to reuse).
 *   4. A section that does not apply is OMITTED, never softened. A worker told it
 *      "usually cannot" delegate still tries, then reports the refusal as a blocker.
 */
export const buildPreamble = ({
  run,
  task,
  dispatch,
  cbdsCommand = resolveCbdsCommand(),
  workerKind = 'agent',
  canDispatchSubWorkers = false,
  baseDrift = null,
}) => {
  const c = cbdsCommand;

  const header = `${RULE}
You are working inside Herdr as a cbds worker. You are a dispatched worker and a
coordinator is blocked waiting for your report.

  run_id       ${run.run_id}
  task_id      ${task.task_id}
  dispatch_id  ${dispatch.dispatch_id}
  attempt      ${dispatch.attempt} of ${task.max_attempts}

You reach the coordinator ONLY through the commands below. Do not use Slack, GitHub
comments, a chat tool, or any other channel to reach a human during this run.

=== CLI COMMANDS ===

  # Report the terminal outcome (REQUIRED exactly once).
  #
  # RULE: --body is a 3-sentence executive summary — what you did, what you found,
  # what is left. Never send an empty body; the coordinator reads the body first and
  # only opens artifacts if it needs more. Pass a long write-up with --artifact
  # so the coordinator finds it without a file search.
  #
  # RULE: send it exactly once. Use --outcome succeeded when the requested work is
  # done, --outcome failed when it is not. Never encode failure only in prose and
  # never silently stop: an unreported failure is indistinguishable from a hung
  # worker and burns the coordinator's entire timeout.
  #
  # The ids are already in this pane's environment, so you do not pass them.
  ${c} done --outcome succeeded --subject "<short status>" --body "<3-sentence summary>" --files-modified "path/a,path/b"
  ${c} done --outcome failed --subject "<short status>" --body "<why it failed and what you tried>"

  # RULE: send a heartbeat every ${HEARTBEAT_INTERVAL_MIN} minutes while actively working.
  # The coordinator uses it to tell "still thinking" from "hung". Skip heartbeats only
  # while blocked inside \`ask\` — that call is itself a liveness signal.
  ${c} heartbeat --phase "<investigating|implementing|reviewing|waiting>"

  # Ask the coordinator a question and block until it answers.
  #
  # BEHAVIOUR RULE (MUST NOT VIOLATE): NEVER ask a human through your own interactive
  # UI — AskUserQuestion, a TUI confirm, a y/n prompt, a permission dialog. The
  # coordinator cannot see it and cannot answer it, so your session hangs forever
  # waiting on a human who is not looking. Every interactive question goes through
  # \`ask\` below.
  #
  # \`ask\` records the question durably and blocks until the coordinator replies,
  # then prints the answer. If it times out, resume by id — never ask again, or you
  # create a duplicate thread nobody can disambiguate.
  ${c} ask --question "<your question>" --options "<optional,comma,separated>" --timeout 600000
  ${c} ask --resume <message_id> --timeout 600000

  # Escalate a blocker BEFORE completion, when the coordinator must act before you
  # can continue. This does not settle your task: you still owe exactly one report.
  ${c} escalate --subject "Blocked: <reason>" --body "<details>"

  # Read follow-up guidance the coordinator sent you.
  ${c} check

  # RULE: run this first if anything is unclear. If it does not say you are a LIVE
  # worker, this preamble is STALE — inherited from scrollback or a handoff. Do NOT
  # report and do NOT send lifecycle messages. Tell the user instead.
  ${c} whoami
`;

  const postDone = workerKind === 'bare-shell'
    ? `=== AFTER YOU REPORT ===

Your report ends your turn for this task. Your dispatched work is complete: stop and
take no further action — do NOT start new or unrelated work, do NOT run a sleep/poll
loop, and do NOT keep calling \`${c} check\`. The coordinator has already recorded
your completion and expects no further output.

Exit the shell after reporting. A bare-shell worker has no idle agent prompt for the
coordinator to reuse; if it has more for you it will dispatch another worker.`
    : `=== AFTER YOU REPORT ===

Your report ends your turn for this task. Your dispatched work is complete: stop,
return to an idle prompt, and take no further action — do NOT start new or unrelated
work, do NOT run a sleep/poll loop, and do NOT keep calling \`${c} check\`. The
coordinator has already recorded your completion and expects no further output.

A direct instruction from the user takes precedence over this idle rule. Treat it as
new user-owned work: follow it without coordinator approval or a fresh dispatch, and
do not send lifecycle messages using the settled task or dispatch ids. Never refuse a
direct user request because you were a worker.

Do not close this pane. Your pane stays available, and if the coordinator has more
for you it arrives as a fresh preamble + TASK block. Treat that as supervised work
under the new dispatch, and ignore stale follow-ups from the settled task.`;

  const subDispatch = canDispatchSubWorkers
    ? `

=== SUB-DISPATCH ===
You may dispatch sub-workers for this task. Create each task, then start it:

  ${c} task create --spec "<sub-task>" --json
  ${c} dispatch start --task <task_id> --agent <agent> --json

You own those sub-workers: wait for their reports and do not send your own until they
have settled. Nesting is capped, so a sub-worker of yours may not be able to delegate
further.
---`
    : '';

  const drift = baseDrift && baseDrift.behind > 0
    ? `

--- BASE DRIFT ---
Your working tree is ${baseDrift.behind} commit(s) behind ${baseDrift.base}. The most
recent subjects on ${baseDrift.base} that you do NOT have:
${baseDrift.recentSubjects.map((x) => `  - ${x}`).join('\n')}

If any look relevant, either pull them in (\`git pull --rebase\`) or escalate to the
coordinator before starting.
---`
    : '';

  return `${header}${drift}${subDispatch}

${postDone}

=== TASK — ${task.title} ===

Run objective: ${run.objective}

${task.spec}
${RULE}`;
};

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Environment injected into the worker pane at split time. This is the durable half
 * of the identity contract: `cbds done` needs no arguments because of it.
 */
export const workerEnv = ({ run, task, dispatch, stateDir, depth }) => ({
  CBDS_RUN_ID: run.run_id,
  CBDS_TASK_ID: task.task_id,
  CBDS_DISPATCH_ID: dispatch.dispatch_id,
  CBDS_STATE_DIR: stateDir,
  CBDS_ROLE: 'worker',
  CBDS_DEPTH: String(depth),
  CBDS_BIN: 'cbds',
  // The shim dir goes first so `cbds` is a single word in every shell, including fish.
  PATH: workerPath(),
});
