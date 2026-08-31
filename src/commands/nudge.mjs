import { requireFlag } from '../core/args.mjs';
import { conflict, notFound } from '../core/errors.mjs';
import { emit, say, table, c, relTime, truncate } from '../core/output.mjs';
import { loadDispatch, saveDispatch, listDispatches, listTasks, addHint } from '../core/model.mjs';
import { resolveRun, resolveDispatchId } from '../core/context.mjs';
import { agentGet, agentPrompt } from '../herdr/client.mjs';
import { scanInbox, messageType } from '../core/inbox.mjs';

/**
 * Remind a worker that finished its turn without reporting.
 *
 * The contract cannot make a model run a command. Seen in the wild on a small model:
 * the worker did the work, ran the tests, then wrote its findings as prose on its own
 * screen — addressing the coordinator by name — and went idle. The result existed and
 * was unreachable, which is precisely the failure cbds exists to remove.
 *
 * The situation is detectable, though: an agent sitting `idle`/`done` while its
 * dispatch is still unsettled has finished and not reported. One short reminder
 * recovers it, and the work is not repeated.
 */

const REMINDER = (cmd = 'cbds') =>
  `You finished your turn without reporting, so your coordinator is still blocked. `
  + `Summarise what you did in one \`${cmd} done\` call now — `
  + `--outcome succeeded (or failed) with --body. Do not redo the work.`;

/** Dispatches whose worker looks done-but-silent. */
export const forgetfulDispatches = async (store, runId) => {
  const R = store.run(runId);
  const settled = new Set(scanInbox(R)
    .filter((m) => messageType(m) === 'report' && m.acceptance?.accepted)
    .map((m) => m.dispatch_id));

  const out = [];
  for (const d of listDispatches(store, runId)) {
    if (d.state !== 'dispatched' || settled.has(d.dispatch_id)) continue;
    if (!d.target?.pane_id) continue;
    const info = await agentGet(d.target.agent_name ?? d.target.pane_id).catch(() => null);
    const status = info?.agent_status;
    // `idle` and `done` both mean the turn ended. `working` and `blocked` do not.
    if (status === 'idle' || status === 'done') out.push({ dispatch: d, status });
  }
  return out;
};

/** Send one reminder and record it. Shared by `cbds nudge` and the wait sweep. */
export const nudgeDispatch = async (store, dispatch, status = 'idle') => {
  const label = dispatch.target.agent_name ?? dispatch.target.pane_id;
  let delivered = false;
  try {
    const res = await agentPrompt({ target: label, text: REMINDER(), wait: false, timeoutMs: 20_000 });
    delivered = !res?._allowed;
  } catch { delivered = false; }
  addHint(store, dispatch, 'nudged', status);
  dispatch.nudges = (dispatch.nudges ?? 0) + 1;
  saveDispatch(store, dispatch, { event: 'dispatch.nudged', status, delivered });
  return { target: label, delivered };
};

export const nudge = {
  summary: 'Remind workers that finished their turn without reporting',
  usage: 'cbds nudge [<dispatch_id>] [--all] [--dry-run]',
  flags: {
    all: { type: 'boolean', describe: 'every worker in the run that looks done-but-silent' },
    'dry-run': { type: 'boolean', describe: 'list who would be nudged, send nothing' },
    force: { type: 'boolean', describe: 'nudge even if the agent still looks busy' },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const tasks = Object.fromEntries(listTasks(store, run.run_id).map((t) => [t.task_id, t]));

    let targets;
    if (ctx.positional[0]) {
      const id = resolveDispatchId(store, run.run_id, ctx.positional[0]);
      const d = loadDispatch(store, run.run_id, id);
      if (d.state !== 'dispatched' && !ctx.flags.force) {
        throw conflict('dispatch_not_live', `dispatch ${id} is ${d.state}, not live`);
      }
      const info = await agentGet(d.target.agent_name ?? d.target.pane_id).catch(() => null);
      targets = [{ dispatch: d, status: info?.agent_status ?? 'unknown' }];
    } else if (ctx.flags.all) {
      targets = await forgetfulDispatches(store, run.run_id);
    } else {
      throw notFound('dispatch', '(pass a dispatch id or --all)');
    }

    if (!targets.length) {
      say(ctx, c.dim('  no worker is sitting idle with an unreported dispatch'));
      return emit(ctx, { nudged: [], count: 0 });
    }

    const rows = [];
    for (const { dispatch, status } of targets) {
      const label = dispatch.target.agent_name ?? dispatch.target.pane_id;
      const busy = status === 'working' || status === 'blocked';
      if (busy && !ctx.flags.force) {
        rows.push({ target: label, status, result: c.dim('skipped (still busy)') });
        continue;
      }
      if (ctx.flags['dry-run']) {
        rows.push({ target: label, status, result: c.yellow('would nudge') });
        continue;
      }
      try {
        const res = await agentPrompt({ target: label, text: REMINDER(), wait: false, timeoutMs: 20_000 });
        const ok = !res?._allowed;
        addHint(store, dispatch, 'nudged', status);
        dispatch.nudges = (dispatch.nudges ?? 0) + 1;
        saveDispatch(store, dispatch, { event: 'dispatch.nudged', status });
        rows.push({ target: label, status, result: ok ? c.green('nudged') : c.yellow(res._allowed) });
      } catch (err) {
        rows.push({ target: label, status, result: c.red(err.code ?? 'failed') });
      }
    }

    say(ctx, table(rows.map((r, i) => ({ ...r, task: truncate(tasks[targets[i].dispatch.task_id]?.title ?? '', 30) })), [
      { header: 'WORKER', get: (r) => c.bold(r.target) },
      { header: 'AGENT', get: (r) => r.status },
      { header: 'TASK', get: (r) => r.task },
      { header: 'RESULT', get: (r) => r.result },
    ]));
    say(ctx, c.dim('\n  then keep waiting: cbds wait --timeout 900000'));
    return emit(ctx, { count: rows.length, nudged: rows });
  },
};
