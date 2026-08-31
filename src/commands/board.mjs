import fs from 'node:fs';
import { emit, say, table, c, paintState, relTime, duration, truncate } from '../core/output.mjs';
import { listRuns, listTasks, listDispatches } from '../core/model.mjs';
import { scanInbox, scanRejected, scanOutbox, readCursor, messageType } from '../core/inbox.mjs';
import { resolveRun, readActiveRunId } from '../core/context.mjs';
import { readEvents } from '../core/store.mjs';
import { insideHerdr, callerPane } from '../herdr/client.mjs';

const CLEAR = `${String.fromCharCode(27)}[H${String.fromCharCode(27)}[2J${String.fromCharCode(27)}[3J`;

const snapshot = (store, run) => {
  const R = store.run(run.run_id);
  const tasks = listTasks(store, run.run_id);
  const dispatches = listDispatches(store, run.run_id);
  const byId = new Map(dispatches.map((d) => [d.dispatch_id, d]));
  const cursor = readCursor(R);
  const inbox = scanInbox(R);
  const reports = inbox.filter((m) => messageType(m) === 'report');
  const answered = new Set(scanOutbox(R).filter((m) => messageType(m) === 'reply').map((m) => m.in_reply_to));
  const openQuestions = inbox.filter((m) => messageType(m) === 'question' && !answered.has(m.report_id));
  return {
    openQuestions,
    run,
    tasks: tasks.sort((a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at)),
    dispatches,
    byId,
    reports,
    rejected: scanRejected(R),
    unacked: inbox.filter((r) => r.seq > cursor.acked_seq),
    events: readEvents(R.events, 12),
  };
};

const render = (snap, { width = process.stdout.columns ?? 100 } = {}) => {
  const { run, tasks, byId, reports, rejected, unacked, openQuestions } = snap;
  const out = [];
  const rule = c.dim('─'.repeat(Math.max(20, Math.min(width - 2, 96))));

  out.push(`${c.bold('cbds board')}  ${c.dim(new Date().toISOString().replace('T', ' ').slice(0, 19))}`);
  out.push(rule);
  out.push(`${c.bold(run.run_id)}  ${paintState(run.state)}  ${truncate(run.objective, 56)}`);
  out.push('');

  const counts = tasks.reduce((a, t) => ({ ...a, [t.state]: (a[t.state] ?? 0) + 1 }), {});
  out.push(`  ${Object.entries(counts).map(([k, v]) => `${paintState(k)} ${c.bold(v)}`).join('   ') || c.dim('no tasks')}`);
  out.push(`  ${c.dim('reports')} ${reports.length} accepted · ${unacked.length} unacked · ${rejected.length ? c.red(`${rejected.length} rejected`) : '0 rejected'}`);
  if (openQuestions?.length) {
    out.push('');
    out.push(c.red(`  ${openQuestions.length} worker(s) BLOCKED waiting on an answer:`));
    for (const q of openQuestions.slice(0, 4)) {
      out.push(`    ${c.bold(q.report_id)}  ${truncate(q.question ?? q.subject ?? '', 52)}`);
    }
  }
  out.push('');

  out.push(table(tasks, [
    { header: 'TASK', get: (t) => t.task_id.replace('tsk_', '') },
    { header: 'STATE', get: (t) => paintState(t.state) },
    { header: 'TRY', get: (t) => `${t.attempts}/${t.max_attempts}` },
    { header: 'PANE', get: (t) => byId.get(t.live_dispatch_id)?.target?.pane_id ?? c.dim('—') },
    { header: 'AGENT', get: (t) => byId.get(t.live_dispatch_id)?.target?.agent_kind ?? c.dim('—') },
    {
      header: 'ELAPSED',
      get: (t) => {
        const d = byId.get(t.live_dispatch_id);
        return d?.started_at && t.state === 'dispatched'
          ? duration(Date.now() - new Date(d.started_at).getTime())
          : c.dim('—');
      },
    },
    { header: 'TITLE', get: (t) => truncate(t.title, Math.max(20, width - 62)) },
  ]));

  if (snap.events.length) {
    out.push('');
    out.push(c.dim('  recent'));
    for (const e of snap.events.slice(-8)) {
      out.push(`  ${c.dim(relTime(e.at).padEnd(9))} ${e.event ?? '?'}${e.task_id ? c.dim(` ${e.task_id.slice(-6)}`) : ''}${e.outcome ? ` ${paintState(e.outcome)}` : ''}`);
    }
  }
  return out.join('\n');
};

export const board = {
  summary: 'Live overview of runs, tasks, dispatches and their Herdr pane ids',
  usage: 'cbds board [--once] [--interval <ms>]',
  flags: {
    once: { type: 'boolean', describe: 'render a single frame and exit' },
    interval: { type: 'number', default: 2000, placeholder: 'ms', describe: 'redraw interval' },
    all: { type: 'boolean', describe: 'include every open run, not just the active one' },
  },
  async run(ctx) {
    const store = ctx.store();

    const collect = () => (ctx.flags.all
      ? listRuns(store).filter((r) => r.state === 'open')
      : [resolveRun(ctx)]);

    if (ctx.json || ctx.flags.once) {
      const snaps = collect().map((r) => snapshot(store, r));
      if (!ctx.json) say(ctx, snaps.map((s) => render(s)).join('\n\n'));
      return emit(ctx, {
        active_run_id: readActiveRunId(store),
        herdr: { inside: insideHerdr(), ...callerPane() },
        runs: snaps.map((s) => ({
          run: s.run,
          tasks: s.tasks,
          dispatches: s.dispatches,
          reports: { accepted: s.reports.length, unacked: s.unacked.length, rejected: s.rejected.length },
        })),
      });
    }

    /* ---- live loop, for the plugin board pane ---- */

    const draw = () => {
      let frame;
      try {
        frame = collect().map((r) => render(snapshot(store, r))).join('\n\n');
      } catch (err) {
        frame = `${c.yellow('cbds board')}\n\n  ${err.message}\n\n  ${c.dim('waiting for a run…')}`;
      }
      process.stdout.write(CLEAR);
      process.stdout.write(`${frame}\n`);
    };

    draw();
    const timer = setInterval(draw, Math.max(500, ctx.flags.interval));

    // Redraw immediately when the store changes, so the board feels live rather than
    // merely periodic. The interval stays the correctness floor if watches are lost.
    const watchers = [];
    try {
      const run = resolveRun(ctx);
      const R = store.run(run.run_id);
      for (const dir of [R.tasks, R.dispatches, R.inbox]) {
        try { watchers.push(fs.watch(dir, () => setTimeout(draw, 40))); } catch { /* optional */ }
      }
    } catch { /* no run yet; the interval still polls */ }

    await new Promise((resolve) => {
      const stop = () => {
        clearInterval(timer);
        for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    return null;
  },
};
