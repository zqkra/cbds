import fs from 'node:fs';
import { csv, oneOf } from '../core/args.mjs';
import { CbdsError, EXIT, usage, stale, conflict } from '../core/errors.mjs';
import { emit, say, kv, c, paintState } from '../core/output.mjs';
import {
  loadTask, saveTask, loadDispatch, saveDispatch, loadRun,
  OUTCOMES, OUTCOME_TO_TASK_STATE,
} from '../core/model.mjs';
import { buildReport, writeReport } from '../core/inbox.mjs';
import { nowIso, withLock } from '../core/store.mjs';
import { clearPanePaint, paintPane } from '../herdr/client.mjs';

/**
 * The authoritative completion signal.
 *
 * Acceptance is deliberately strict and always recorded. A report is accepted only if
 * ALL of these hold:
 *   1. the run, task and dispatch all resolve;
 *   2. the dispatch belongs to that task;
 *   3. the dispatch still holds authority (not superseded by a retry);
 *   4. the dispatch has not already settled;
 *   5. the dispatch is the task's live dispatch.
 *
 * A report failing any check is still persisted, to inbox/rejected/, because a zombie
 * worker attempting to complete a superseded dispatch is exactly the situation an
 * orchestrator needs to be able to see.
 */
export const done = {
  summary: 'Report completion (run this from the worker pane — exactly once)',
  usage: 'cbds done --outcome succeeded|failed|blocked --body <text>',
  flags: {
    outcome: { type: 'string', describe: 'succeeded | failed | blocked (REQUIRED)' },
    'task-id': { type: 'string', describe: 'defaults to $CBDS_TASK_ID' },
    'dispatch-id': { type: 'string', describe: 'defaults to $CBDS_DISPATCH_ID' },
    subject: { type: 'string', describe: 'one-line status' },
    body: { type: 'string', describe: 'what you did, what you found, what remains' },
    'body-file': { type: 'string', placeholder: 'path', describe: 'read the body from a file' },
    'files-modified': { type: 'string', multiple: true, placeholder: 'csv', describe: 'paths you changed' },
    artifact: { type: 'string', multiple: true, placeholder: 'path', describe: 'fuller report on disk, repeatable' },
    question: { type: 'string', describe: 'what you need (use with --outcome blocked)' },
    'next-steps': { type: 'string', describe: 'what should happen next' },
  },
  async run(ctx) {
    const outcome = oneOf(
      ctx.flags.outcome ?? (() => {
        throw usage('--outcome is required: succeeded, failed, or blocked',
          'never encode failure only in prose — an unreported failure is indistinguishable from a hung worker');
      })(),
      OUTCOMES, 'outcome',
    );

    const taskId = ctx.flags['task-id'] ?? process.env.CBDS_TASK_ID;
    const dispatchId = ctx.flags['dispatch-id'] ?? process.env.CBDS_DISPATCH_ID;
    const runId = ctx.flags.run ?? process.env.CBDS_RUN_ID;

    if (!taskId || !dispatchId) {
      throw usage('no dispatch identity: pass --task-id and --dispatch-id',
        'if you are inside a cbds worker pane these come from the environment; run `cbds whoami` to check. If whoami reports nothing, your preamble is stale — do not report.');
    }

    const store = ctx.store();
    const run = loadRun(store, runId ?? (() => {
      throw usage('no run id: pass --run or set CBDS_RUN_ID');
    })());
    const R = store.run(run.run_id);

    const body = ctx.flags['body-file']
      ? fs.readFileSync(ctx.flags['body-file'], 'utf8')
      : ctx.flags.body;

    if (outcome === 'blocked' && !ctx.flags.question && !body) {
      throw usage('--outcome blocked needs --question (or at least --body)',
        'the coordinator has to know what would unblock you');
    }

    const report = buildReport({
      runId: run.run_id, taskId, dispatchId, outcome,
      subject: ctx.flags.subject,
      body,
      filesModified: csv(ctx.flags['files-modified']),
      artifacts: ctx.flags.artifact ?? [],
      nextSteps: ctx.flags['next-steps'],
      question: ctx.flags.question,
    });

    /* ---- acceptance, under the run lock so two workers cannot both win ---- */

    const verdict = withLock(R.lock, () => {
      let task; let dispatch;
      try { task = loadTask(store, run.run_id, taskId); }
      catch { return { accepted: false, reason: 'unknown_task' }; }
      try { dispatch = loadDispatch(store, run.run_id, dispatchId); }
      catch { return { accepted: false, reason: 'unknown_dispatch' }; }

      if (dispatch.task_id !== task.task_id) return { accepted: false, reason: 'dispatch_task_mismatch', task, dispatch };
      if (dispatch.state === 'settled') return { accepted: false, reason: 'already_settled', task, dispatch };
      if (!dispatch.authority || dispatch.state === 'superseded') return { accepted: false, reason: 'stale_dispatch', task, dispatch };
      if (task.live_dispatch_id && task.live_dispatch_id !== dispatch.dispatch_id) {
        return { accepted: false, reason: 'stale_dispatch', task, dispatch };
      }
      return { accepted: true, reason: null, task, dispatch };
    });

    report.acceptance = { accepted: verdict.accepted, reason: verdict.reason, at: nowIso() };

    /* ---- persist FIRST: the record is the truth, and it must exist before we act ---- */

    const { report: stored } = writeReport(R, report);

    if (!verdict.accepted) {
      const message = {
        unknown_task: `no task ${taskId} in run ${run.run_id}`,
        unknown_dispatch: `no dispatch ${dispatchId} in run ${run.run_id}`,
        dispatch_task_mismatch: `dispatch ${dispatchId} does not belong to task ${taskId}`,
        already_settled: `dispatch ${dispatchId} already settled (outcome: ${verdict.dispatch?.outcome})`,
        stale_dispatch: `dispatch ${dispatchId} no longer holds completion authority for task ${taskId}`,
      }[verdict.reason] ?? verdict.reason;

      const err = verdict.reason === 'already_settled'
        ? conflict('already_settled', message, 'send worker_done exactly once; the first report stands')
        : stale(verdict.reason, message, { report_id: stored.report_id, filed_as: 'rejected' });
      err.details = { ...(err.details ?? {}), report_id: stored.report_id, task_id: taskId, dispatch_id: dispatchId };
      err.hint ??= 'this attempt was superseded (probably by a retry). Your work is not lost, but the coordinator is no longer listening on this dispatch. Tell the user.';
      throw err;
    }

    /* ---- settle the dispatch and the task ---- */

    const { task, dispatch } = verdict;
    dispatch.state = 'settled';
    dispatch.outcome = outcome;
    dispatch.report_id = stored.report_id;
    dispatch.settled_at = nowIso();
    dispatch.authority = false;   // a settled dispatch cannot report again
    saveDispatch(store, dispatch, { event: 'dispatch.settled', outcome, report_id: stored.report_id });

    const before = task.state;
    task.state = OUTCOME_TO_TASK_STATE[outcome];
    task.live_dispatch_id = outcome === 'succeeded' ? null : task.live_dispatch_id;
    task.result = {
      outcome,
      subject: stored.subject,
      body: stored.body,
      files_modified: stored.files_modified,
      artifacts: stored.artifacts,
      question: stored.question,
      next_steps: stored.next_steps,
      report_id: stored.report_id,
      dispatch_id: dispatch.dispatch_id,
      at: stored.reported_at,
    };
    saveTask(store, task, { event: 'task.settled', from: before, to: task.state, outcome });

    if (dispatch.target?.pane_id) {
      const colour = { succeeded: 'cbds ✓ reported', failed: 'cbds ✗ failed', blocked: 'cbds ? blocked' }[outcome];
      await paintPane(dispatch.target.pane_id, {
        tokens: { cbds: outcome },
        stateLabels: { idle: colour, done: colour },
      });
    }

    say(ctx, `${c.green('report accepted')}  ${c.bold(stored.report_id)}  ${paintState(outcome)}`);
    say(ctx, kv([
      ['task', `${task.task_id} ${c.dim('->')} ${paintState(task.state)}`],
      ['dispatch', `${dispatch.dispatch_id} ${c.dim('->')} settled`],
      ['seq', String(stored.seq)],
    ]));
    say(ctx, c.dim('\n  the coordinator has been signalled. Stop here and idle at your prompt.'));

    return emit(ctx, { report: stored, task, dispatch });
  },
};

/** Worker self-check. The stale-preamble defence: no dispatch means do not report. */
export const whoami = {
  summary: 'Show this pane’s cbds identity (worker self-check)',
  usage: 'cbds whoami',
  flags: {},
  async run(ctx) {
    const env = {
      run_id: process.env.CBDS_RUN_ID ?? null,
      task_id: process.env.CBDS_TASK_ID ?? null,
      dispatch_id: process.env.CBDS_DISPATCH_ID ?? null,
      role: process.env.CBDS_ROLE ?? null,
      depth: Number.parseInt(process.env.CBDS_DEPTH ?? '0', 10) || 0,
      state_dir: process.env.CBDS_STATE_DIR ?? null,
      pane_id: process.env.HERDR_PANE_ID ?? null,
    };

    if (!env.dispatch_id) {
      say(ctx, `${c.yellow('not a cbds worker')} — this pane carries no dispatch identity.`);
      say(ctx, c.dim('  If you were handed a cbds preamble, it is STALE (inherited from scrollback'));
      say(ctx, c.dim('  or a handoff). Do NOT run `cbds done`. Tell the user instead.'));
      return emit(ctx, { worker: false, ...env });
    }

    let live = null; let task = null; let dispatch = null;
    try {
      const store = ctx.store();
      task = loadTask(store, env.run_id, env.task_id);
      dispatch = loadDispatch(store, env.run_id, env.dispatch_id);
      live = dispatch.authority && dispatch.state === 'dispatched' && task.live_dispatch_id === dispatch.dispatch_id;
    } catch { live = false; }

    say(ctx, `${live ? c.green('live cbds worker') : c.yellow('cbds worker — NOT live')}`);
    say(ctx, kv([
      ['run', env.run_id],
      ['task', env.task_id ? `${env.task_id}  ${task ? paintState(task.state) : c.dim('(unreadable)')}` : null],
      ['dispatch', env.dispatch_id ? `${env.dispatch_id}  ${dispatch ? paintState(dispatch.state) : c.dim('(unreadable)')}` : null],
      ['authority', dispatch ? (dispatch.authority ? c.green('yes — you may report') : c.red('no — superseded, do NOT report')) : null],
      ['coordinator', dispatch?.coordinator
        ? `${dispatch.coordinator.agent_name ?? dispatch.coordinator.pane_id}  ${c.dim('— ask it with `cbds ask`, it will answer')}`
        : (process.env.CBDS_COORDINATOR ?? null)],
      ['depth', String(env.depth)],
      ['pane', env.pane_id],
      ['store', env.state_dir],
    ]));
    if (task) say(ctx, `\n  ${c.dim('task:')} ${task.title}`);
    if (live) say(ctx, c.dim('\n  when finished: cbds done --outcome succeeded --body "…"'));

    return emit(ctx, { worker: true, live, ...env, task, dispatch });
  },
};
