import { csv, requireFlag } from '../core/args.mjs';
import { conflict } from '../core/errors.mjs';
import { emit, say, table, kv, c, paintState, relTime, truncate } from '../core/output.mjs';
import { createRun, loadRun, listRuns, saveRun, listTasks, listDispatches } from '../core/model.mjs';
import { scanInbox, scanRejected, readCursor } from '../core/inbox.mjs';
import { resolveRun, writeActiveRunId, readActiveRunId } from '../core/context.mjs';
import { nowIso } from '../core/store.mjs';

const labelsFrom = (values) => Object.fromEntries(
  csv(values).map((pair) => {
    const i = pair.indexOf('=');
    return i < 0 ? [pair, 'true'] : [pair.slice(0, i), pair.slice(i + 1)];
  }),
);

export const summarise = (store, run) => {
  const tasks = listTasks(store, run.run_id);
  const dispatches = listDispatches(store, run.run_id);
  const R = store.run(run.run_id);
  const cursor = readCursor(R);
  const reports = scanInbox(R);
  const byState = (items, key = 'state') => items.reduce((acc, t) => {
    acc[t[key]] = (acc[t[key]] ?? 0) + 1;
    return acc;
  }, {});
  return {
    run_id: run.run_id,
    objective: run.objective,
    state: run.state,
    created_at: run.created_at,
    tasks: { total: tasks.length, ...byState(tasks) },
    dispatches: { total: dispatches.length, ...byState(dispatches) },
    reports: {
      total: reports.length,
      unacked: reports.filter((r) => r.seq > cursor.acked_seq).length,
      rejected: scanRejected(R).length,
    },
    live_panes: dispatches.filter((d) => d.state === 'dispatched').map((d) => ({
      dispatch_id: d.dispatch_id, task_id: d.task_id, pane_id: d.target.pane_id,
    })),
  };
};

export const create = {
  summary: 'Create a run: a durable namespace and coordinator inbox',
  usage: 'cbds run create --objective <text> [--label k=v] [--bind]',
  flags: {
    objective: { type: 'string', describe: 'what this run is for' },
    label: { type: 'string', multiple: true, describe: 'k=v metadata, repeatable' },
    bind: { type: 'boolean', default: true, describe: 'bind as this project’s active run' },
  },
  async run(ctx) {
    const objective = requireFlag(ctx.flags, 'objective', 'e.g. --objective "Ship the billing audit"');
    const store = ctx.store(true);
    const run = createRun(store, { objective, labels: labelsFrom(ctx.flags.label) });
    if (ctx.flags.bind) writeActiveRunId(store, run.run_id);

    say(ctx, `${c.green('run created')}  ${c.bold(run.run_id)}`);
    say(ctx, kv([
      ['objective', run.objective],
      ['state', paintState(run.state)],
      ['store', ctx.stateRoot],
      ['bound', ctx.flags.bind ? 'yes (active run for this project)' : 'no'],
    ]));
    say(ctx, c.dim('\n  next: cbds task create --spec "<the work>"'));
    return emit(ctx, run);
  },
};

export const list = {
  summary: 'List runs in this project',
  usage: 'cbds run list [--state open|closed]',
  flags: { state: { type: 'string', describe: 'filter by state' } },
  async run(ctx) {
    const store = ctx.store();
    const active = readActiveRunId(store);
    let runs = listRuns(store);
    if (ctx.flags.state) runs = runs.filter((r) => r.state === ctx.flags.state);

    say(ctx, table(runs, [
      { header: '', get: (r) => (r.run_id === active ? c.green('*') : ' ') },
      { header: 'RUN', get: (r) => c.bold(r.run_id) },
      { header: 'STATE', get: (r) => paintState(r.state) },
      { header: 'CREATED', get: (r) => relTime(r.created_at) },
      { header: 'OBJECTIVE', get: (r) => truncate(r.objective, 52) },
    ]));
    return emit(ctx, { active_run_id: active, runs });
  },
};

export const show = {
  summary: 'Show one run in full',
  usage: 'cbds run show [<run_id>]',
  flags: {},
  async run(ctx) {
    const store = ctx.store();
    const run = ctx.positional[0] ? loadRun(store, ctx.positional[0]) : resolveRun(ctx);
    const stats = summarise(store, run);
    say(ctx, `${c.bold(run.run_id)}  ${paintState(run.state)}`);
    say(ctx, kv([
      ['objective', run.objective],
      ['created', `${relTime(run.created_at)}  ${c.dim(run.created_at)}`],
      ['project', run.project_root],
      ['tasks', `${stats.tasks.total} total`],
      ['dispatches', `${stats.dispatches.total} total`],
      ['reports', `${stats.reports.total} accepted, ${stats.reports.unacked} unacked, ${stats.reports.rejected} rejected`],
      ['labels', Object.entries(run.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') || null],
    ]));
    return emit(ctx, { ...run, stats });
  },
};

export const status = {
  summary: 'Aggregate task/dispatch/report counts for a run',
  usage: 'cbds run status [<run_id>]',
  flags: {},
  async run(ctx) {
    const store = ctx.store();
    const run = ctx.positional[0] ? loadRun(store, ctx.positional[0]) : resolveRun(ctx);
    const stats = summarise(store, run);
    const line = (obj) => Object.entries(obj).filter(([k]) => k !== 'total')
      .map(([k, v]) => `${paintState(k)} ${c.bold(v)}`).join('  ') || c.dim('none');
    say(ctx, `${c.bold(run.run_id)}  ${truncate(run.objective, 50)}`);
    say(ctx, kv([
      ['tasks', `${stats.tasks.total}   ${line(stats.tasks)}`],
      ['dispatches', `${stats.dispatches.total}   ${line(stats.dispatches)}`],
      ['reports', `${stats.reports.total} accepted  ${stats.reports.unacked} unacked  ${stats.reports.rejected} rejected`],
      ['live panes', stats.live_panes.map((p) => `${p.pane_id}(${p.task_id.slice(-6)})`).join(' ') || null],
    ]));
    return emit(ctx, stats);
  },
};

export const close = {
  summary: 'Close a run (refuses while dispatches are live unless --force)',
  usage: 'cbds run close [<run_id>] [--force]',
  flags: { force: { type: 'boolean', describe: 'close even with live dispatches' } },
  async run(ctx) {
    const store = ctx.store();
    const run = ctx.positional[0] ? loadRun(store, ctx.positional[0]) : resolveRun(ctx);
    if (run.state === 'closed') {
      say(ctx, c.dim(`run ${run.run_id} is already closed`));
      return emit(ctx, run);
    }
    const live = listDispatches(store, run.run_id).filter((d) => d.state === 'dispatched');
    if (live.length && !ctx.flags.force) {
      throw conflict('run_has_live_dispatches',
        `run ${run.run_id} still has ${live.length} live dispatch(es)`,
        'wait for them, or pass --force to close anyway (workers keep running)');
    }
    run.state = 'closed';
    run.closed_at = nowIso();
    saveRun(store, run);
    say(ctx, `${c.green('run closed')}  ${c.bold(run.run_id)}${live.length ? c.yellow(`  (${live.length} dispatch(es) left running)`) : ''}`);
    return emit(ctx, run);
  },
};

export const use = {
  summary: 'Bind a run as the active run for this project',
  usage: 'cbds run use <run_id>',
  flags: {},
  async run(ctx) {
    const store = ctx.store();
    const run = loadRun(store, requireFlag({ id: ctx.positional[0] }, 'id', 'cbds run use <run_id>'));
    writeActiveRunId(store, run.run_id);
    say(ctx, `${c.green('bound')}  ${c.bold(run.run_id)}  ${c.dim(truncate(run.objective, 40))}`);
    return emit(ctx, run);
  },
};
