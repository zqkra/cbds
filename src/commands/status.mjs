import { emit, say, kv, table, c, duration, truncate } from '../core/output.mjs';
import { listRuns, listTasks, listDispatches } from '../core/model.mjs';
import { scanInbox, scanRejected, readCursor } from '../core/inbox.mjs';
import { readActiveRunId } from '../core/context.mjs';
import { insideHerdr, callerPane, herdrBin } from '../herdr/client.mjs';

/**
 * Herdr connectivity, stated honestly. A session reachable over the socket but with
 * no pane id is a real state (a script, a plugin hook), and saying "pane null" there
 * reads like a bug rather than a fact.
 */
const herdrLabel = () => {
  const { pane_id: paneId } = callerPane();
  if (!insideHerdr()) return c.yellow('not inside a Herdr pane');
  return paneId
    ? `${c.green('connected')} ${c.dim(`pane ${paneId}`)}`
    : `${c.green('connected')} ${c.dim('(no pane context)')}`;
};

/**
 * One screen answering the two questions an agent has on waking up:
 * "what am I?" and "what is live?".
 */
export const status = {
  summary: 'What am I, and what is live? One screen.',
  usage: 'cbds status',
  flags: {},
  async run(ctx) {
    const role = process.env.CBDS_ROLE ?? (process.env.CBDS_DISPATCH_ID ? 'worker' : 'orchestrator');
    const env = {
      role,
      run_id: process.env.CBDS_RUN_ID ?? null,
      task_id: process.env.CBDS_TASK_ID ?? null,
      dispatch_id: process.env.CBDS_DISPATCH_ID ?? null,
      depth: Number.parseInt(process.env.CBDS_DEPTH ?? '0', 10) || 0,
    };

    let store = null;
    let runs = [];
    try { store = ctx.store(); runs = listRuns(store); } catch { /* no store yet */ }

    say(ctx, `${c.bold('cbds')} ${c.dim('· reliable multi-agent orchestration for the Herdr herd')}`);
    say(ctx, '');
    say(ctx, kv([
      ['role', role === 'worker' ? c.yellow('worker') : c.cyan('orchestrator')],
      ['herdr', herdrLabel()],
      ['herdr bin', herdrBin()],
      ['store', store ? ctx.stateRoot : c.dim(`${ctx.stateRoot} (not initialised)`)],
      ['active run', store ? readActiveRunId(store) : null],
      ...(env.dispatch_id ? [['my dispatch', env.dispatch_id], ['my task', env.task_id]] : []),
    ]));

    if (!store) {
      say(ctx, c.dim('\n  no store yet — start with: cbds run create --objective "<what this run is for>"'));
      return emit(ctx, { role, env, herdr: { inside: insideHerdr(), ...callerPane() }, store: null, runs: [] });
    }

    const open = runs.filter((r) => r.state === 'open');
    const detail = open.map((run) => {
      const R = store.run(run.run_id);
      const tasks = listTasks(store, run.run_id);
      const dispatches = listDispatches(store, run.run_id);
      const cursor = readCursor(R);
      const reports = scanInbox(R);
      return {
        run_id: run.run_id,
        objective: run.objective,
        tasks: tasks.length,
        live: dispatches.filter((d) => d.state === 'dispatched'),
        unacked: reports.filter((r) => r.seq > cursor.acked_seq).length,
        rejected: scanRejected(R).length,
        blocked: tasks.filter((t) => t.state === 'blocked').length,
      };
    });

    if (open.length) {
      say(ctx, `\n${c.dim('  open runs')}`);
      say(ctx, table(detail, [
        { header: 'RUN', get: (d) => c.bold(d.run_id) },
        { header: 'TASKS', get: (d) => String(d.tasks) },
        { header: 'LIVE', get: (d) => (d.live.length ? c.yellow(String(d.live.length)) : c.dim('0')) },
        { header: 'UNACKED', get: (d) => (d.unacked ? c.green(String(d.unacked)) : c.dim('0')) },
        { header: 'BLOCKED', get: (d) => (d.blocked ? c.magenta(String(d.blocked)) : c.dim('0')) },
        { header: 'REJECTED', get: (d) => (d.rejected ? c.red(String(d.rejected)) : c.dim('0')) },
        { header: 'OBJECTIVE', get: (d) => truncate(d.objective, 40) },
      ]));

      const live = detail.flatMap((d) => d.live);
      if (live.length) {
        say(ctx, `\n${c.dim('  live workers')}`);
        say(ctx, table(live, [
          { header: 'DISPATCH', get: (d) => d.dispatch_id },
          { header: 'PANE', get: (d) => c.bold(d.target.pane_id ?? '—') },
          { header: 'AGENT', get: (d) => d.target.agent_kind },
          { header: 'RUNNING', get: (d) => duration(Date.now() - new Date(d.started_at).getTime()) },
          { header: 'TASK', get: (d) => d.task_id },
        ]));
      }

      const unacked = detail.reduce((a, d) => a + d.unacked, 0);
      if (unacked) say(ctx, c.green(`\n  ${unacked} report(s) waiting — read them with: cbds wait --timeout 1000`));
      else if (live.length) say(ctx, c.dim('\n  next: cbds wait --timeout 900000'));
    } else {
      say(ctx, c.dim('\n  no open runs — start with: cbds run create --objective "…"'));
    }

    return emit(ctx, { role, env, herdr: { inside: insideHerdr(), ...callerPane() }, store: ctx.stateRoot, runs: detail });
  },
};
