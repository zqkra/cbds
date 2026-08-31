import { csv, requireFlag } from '../core/args.mjs';
import { CbdsError, EXIT, usage } from '../core/errors.mjs';
import { emit, say, kv, c, paintState, duration, relTime, truncate } from '../core/output.mjs';
import { loadTask, loadDispatch, listDispatches, listTasks, addHint, saveDispatch, saveTask } from '../core/model.mjs';
import {
  waitForReport, scanInbox, readCursor, markAcked, messageType, DEFAULT_WAKE_TYPES,
} from '../core/inbox.mjs';
import { resolveRun, resolveTaskId, resolveDispatchId } from '../core/context.mjs';
import { watchPaneDeath } from '../herdr/events.mjs';
import { register as registerWaiter } from '../core/waiters.mjs';
import { forgetfulDispatches, nudgeDispatch } from './nudge.mjs';
import { paneAlive } from '../herdr/client.mjs';

/**
 * The primary receive primitive.
 *
 * Design rules, in priority order:
 *   1. Scan the durable inbox FIRST. A report that already exists satisfies the wait
 *      instantly — this is what makes a wait started after an orchestrator crash correct.
 *   2. Block on a filesystem watch, but treat it purely as a latency hint: every wake
 *      re-scans disk, and a safety poll guarantees progress if notifications are lost.
 *   3. Consume Herdr pane-death events as a fail-fast hint. A dead pane produces
 *      `worker_vanished` (exit 8), never `completed`, and never marks the task failed.
 *   4. Always time out cleanly (exit 4) with enough context for a rolling wait loop.
 */
export const wait = {
  summary: 'Block until an authoritative report arrives (the reliable receive primitive)',
  usage: 'cbds wait --timeout <ms> [--task <id> | --dispatch <id>] [--all]',
  flags: {
    task: { type: 'string', placeholder: 'task_id', describe: 'wait on one task' },
    dispatch: { type: 'string', placeholder: 'dispatch_id', describe: 'wait on one dispatch' },
    timeout: { type: 'number', placeholder: 'ms', describe: 'REQUIRED — no wait is ever unbounded' },
    outcome: { type: 'string', placeholder: 'csv', describe: 'only wake for these outcomes' },
    types: { type: 'string', placeholder: 'csv', describe: `message types that wake you (default: ${DEFAULT_WAKE_TYPES.join(',')})` },
    all: { type: 'boolean', describe: 'wait until every in-scope dispatch has settled' },
    any: { type: 'boolean', default: true, describe: 'return on the first report (default)' },
    ack: { type: 'boolean', default: true, describe: 'acknowledge returned reports' },
    unacked: { type: 'boolean', default: true, describe: 'only consider reports newer than the cursor' },
    poll: { type: 'number', default: 2000, placeholder: 'ms', describe: 'safety poll interval' },
    hints: { type: 'boolean', default: true, describe: 'use Herdr pane events to fail fast' },
    nudge: { type: 'boolean', default: true, describe: 'remind a worker that went idle without reporting' },
    'nudge-after': { type: 'number', default: 25000, placeholder: 'ms', describe: 'grace before the first reminder' },
    'max-nudges': { type: 'number', default: 2, describe: 'reminders per worker before giving up on it' },
  },
  async run(ctx) {
    const timeout = ctx.flags.timeout;
    if (timeout === undefined) {
      throw usage('--timeout <ms> is required',
        'cbds never waits indefinitely. Use rolling windows: a timeout is a checkpoint, not a failure.');
    }
    if (timeout < 1000) throw usage('--timeout must be at least 1000ms');

    const run = resolveRun(ctx);
    const store = ctx.store();
    const R = store.run(run.run_id);

    /* ---- resolve scope: which dispatches would satisfy this wait ---- */

    let scopeDispatches;
    let scopeLabel;
    if (ctx.flags.dispatch) {
      const id = resolveDispatchId(store, run.run_id, ctx.flags.dispatch);
      scopeDispatches = [loadDispatch(store, run.run_id, id)];
      scopeLabel = `dispatch ${id}`;
    } else if (ctx.flags.task) {
      const id = resolveTaskId(store, run.run_id, ctx.flags.task);
      const task = loadTask(store, run.run_id, id);
      scopeDispatches = listDispatches(store, run.run_id).filter((d) => d.task_id === id);
      scopeLabel = `task ${id} (${truncate(task.title, 30)})`;
    } else {
      scopeDispatches = listDispatches(store, run.run_id);
      scopeLabel = `run ${run.run_id}`;
    }

    const scopeIds = new Set(scopeDispatches.map((d) => d.dispatch_id));
    const pending = scopeDispatches.filter((d) => d.state === 'dispatched');
    const wantOutcomes = csv(ctx.flags.outcome);
    const wantTypes = csv(ctx.flags.types).length ? csv(ctx.flags.types) : DEFAULT_WAKE_TYPES;
    const cursor = readCursor(R);

    // A heartbeat is liveness, not news: it never wakes a wait, but it is recorded
    // so a timeout can show how recently the worker was alive.
    const matches = (m) => {
      if (!scopeIds.has(m.dispatch_id)) return false;
      if (!wantTypes.includes(messageType(m))) return false;
      if (ctx.flags.unacked && m.seq <= cursor.acked_seq) return false;
      if (wantOutcomes.length && messageType(m) === 'report' && !wantOutcomes.includes(m.outcome)) return false;
      return true;
    };

    // Only a terminal report settles a dispatch. A question or escalation wakes the
    // coordinator but leaves the worker running and still owing a report.
    const settles = (m) => messageType(m) === 'report';

    const waitAll = Boolean(ctx.flags.all);
    const startedAt = Date.now();

    // Announce that someone is listening. `cbds done` checks this: with a live waiter
    // it stays quiet and lets the wait deliver, without one it pushes the report into
    // the coordinator's pane so it cannot go unread.
    const unregister = registerWaiter(R, scopeLabel);
    const done = (value) => { unregister(); return value; };
    process.once('exit', unregister);

    /* ---- fast path: is it already on disk? ---- */

    const already = scanInbox(R).filter(matches);
    const settledIds = new Set(already.filter(settles).map((r) => r.dispatch_id));
    const outstanding = () => pending.filter((d) => !settledIds.has(d.dispatch_id));

    if (already.length && (!waitAll || outstanding().length === 0)) {
      return done(finish(ctx, R, store, run, already, {
        status: 'found', scopeLabel, elapsed: 0, immediate: true, pending: outstanding(),
      }));
    }

    if (!pending.length && !already.length) {
      unregister();
      throw new CbdsError('nothing_to_wait_for', `no live dispatch in ${scopeLabel}`, {
        exit: EXIT.NOT_FOUND,
        hint: 'dispatch a task first with `cbds dispatch start --task <id>`',
      });
    }

    /* ---- hint channel: fail fast if a worker pane dies ---- */

    let vanished = null;
    /**
     * Recover a worker that finished its turn without reporting.
     *
     * The contract cannot make a model run a command, and a smaller one will happily
     * write its findings as prose on its own screen and go idle — the result exists
     * and is unreachable. That state is detectable (agent idle, dispatch unsettled),
     * so one short reminder recovers it without redoing the work.
     *
     * Slow and capped on purpose: the grace period lets a worker that is about to
     * report do so, and one that ignores two reminders will not answer a third —
     * that is what the timeout is for.
     */
    let nudgeTimer = null;
    if (ctx.flags.nudge) {
      const sweep = async () => {
        try {
          for (const { dispatch: d, status } of await forgetfulDispatches(store, run.run_id)) {
            if (!scopeIds.has(d.dispatch_id)) continue;
            if ((d.nudges ?? 0) >= ctx.flags['max-nudges']) continue;
            if (Date.now() - new Date(d.started_at).getTime() < ctx.flags['nudge-after']) continue;
            await nudgeDispatch(store, d, status);
            if (!ctx.json) say(ctx, c.dim(`  reminded ${d.target.agent_name ?? d.target.pane_id}: idle without a report`));
          }
        } catch { /* best-effort; a reminder must never break the wait */ }
      };
      nudgeTimer = setInterval(sweep, Math.max(10_000, ctx.flags['nudge-after']));
      setTimeout(sweep, ctx.flags['nudge-after']).unref?.();
    }

    // Recreated on every loop iteration: an AbortController latches, so reusing one
    // after a spurious pane event would make the next wait return instantly forever.
    let controller = new AbortController();
    const watchers = [];
    if (ctx.flags.hints) {
      for (const d of pending) {
        if (!d.target?.pane_id) continue;
        try {
          const w = await watchPaneDeath(d.target.pane_id, ({ event }) => {
            if (!vanished) vanished = { dispatch: d, event };
            controller.abort();
          });
          watchers.push(w);
        } catch { /* hints are optional; a failure here must not affect the wait */ }
      }
    }

    const collected = [...already];

    try {
      for (;;) {
        const remaining = timeout - (Date.now() - startedAt);
        if (remaining <= 0) break;

        if (controller.signal.aborted) controller = new AbortController();

        const result = await waitForReport(R, {
          matches: (r) => matches(r) && !collected.some((x) => x.report_id === r.report_id),
          timeoutMs: remaining,
          pollMs: ctx.flags.poll,
          signal: controller.signal,
        });

        if (result.status === 'found') {
          collected.push(...result.reports);
          for (const r of result.reports.filter(settles)) settledIds.add(r.dispatch_id);
          if (!waitAll || outstanding().length === 0) {
            return done(finish(ctx, R, store, run, collected, {
              status: 'found', scopeLabel, elapsed: Date.now() - startedAt, pending: outstanding(),
            }));
          }
          continue;   // --all: keep waiting for the rest
        }

        if (result.status === 'aborted') {
          // A pane-death hint fired. Confirm it against Herdr before acting, then
          // re-scan once: the worker may have reported microseconds before exiting.
          const late = scanInbox(R).filter(matches).filter((r) => !collected.some((x) => x.report_id === r.report_id));
          if (late.length) {
            collected.push(...late);
            for (const r of late.filter(settles)) settledIds.add(r.dispatch_id);
            if (!waitAll || outstanding().length === 0) {
              return done(finish(ctx, R, store, run, collected, {
                status: 'found', scopeLabel, elapsed: Date.now() - startedAt, pending: outstanding(),
              }));
            }
            vanished = null;
            continue;
          }
          if (vanished) {
            const settled = await reportVanished(ctx, store, run, vanished, collected, Date.now() - startedAt);
            // Only a genuinely spurious event resumes the wait. Everything else — a
            // thrown error, or a --json emission that returns null — is terminal.
            if (settled !== SPURIOUS) return done(settled);
            vanished = null;
          }
          continue;
        }

        break;   // timeout
      }
    } finally {
      unregister();
      if (nudgeTimer) clearInterval(nudgeTimer);
      for (const w of watchers) { try { w.stop(); } catch { /* already stopped */ } }
    }

    /* ---- clean timeout ---- */

    const still = outstanding();
    for (const d of still) {
      addHint(store, d, 'wait_timeout', `${duration(timeout)} with no report`);
    }

    const detail = still.map((d) => ({
      dispatch_id: d.dispatch_id,
      task_id: d.task_id,
      pane_id: d.target.pane_id,
      running_for_ms: Date.now() - new Date(d.started_at).getTime(),
      phase: d.phase ?? null,
      last_heartbeat_at: d.last_heartbeat_at ?? null,
      last_hint: d.hints?.at(-1) ?? null,
    }));

    if (!ctx.json) {
      say(ctx, `${c.yellow('wait timed out')} after ${duration(timeout)} on ${scopeLabel}`);
      say(ctx, c.dim('  this is a checkpoint, not a failure — long tasks routinely run 15-60 minutes'));
      for (const d of detail) {
        const beat = d.last_heartbeat_at
          ? c.green(`  alive ${relTime(d.last_heartbeat_at)}${d.phase ? ` (${d.phase})` : ''}`)
          : (d.last_hint ? c.dim(`  last hint: ${d.last_hint.kind}=${d.last_hint.value}`) : '');
        say(ctx, `  ${c.bold(d.dispatch_id)}  pane ${d.pane_id}  running ${duration(d.running_for_ms)}${beat}`);
      }
      say(ctx, c.dim(`\n  keep waiting: cbds wait --timeout ${timeout}${ctx.flags.task ? ` --task ${ctx.flags.task}` : ''}`));
    }

    const err = new CbdsError('wait_timeout', `no report within ${duration(timeout)} on ${scopeLabel}`, {
      exit: EXIT.TIMEOUT,
      details: { scope: scopeLabel, timeout_ms: timeout, collected: collected.length, outstanding: detail },
      hint: 'keep using rolling waits unless the pane died or the user asks you to stop',
    });
    if (ctx.json) { emitErrorJson(ctx, err, { collected, outstanding: detail }); process.exitCode = EXIT.TIMEOUT; return null; }
    throw err;
  },
};

/**
 * Distinguishes "the pane is actually alive, that event was noise" from "handled".
 * Without this, the --json vanish path (which returns null after emitting) is
 * indistinguishable from a spurious event, and the wait silently keeps blocking.
 */
const SPURIOUS = Symbol('cbds.spurious_pane_event');

const emitErrorJson = (ctx, err, extra) => {
  process.stdout.write(`${JSON.stringify({
    ok: false, command: ctx.commandName, error: err.toJSON(), data: extra,
  }, null, 2)}\n`);
};

/** A pane died with no report. Distinct from a timeout, and never a completion. */
const reportVanished = async (ctx, store, run, vanished, collected, elapsed) => {
  const d = vanished.dispatch;
  let alive = true;
  try { alive = await paneAlive(d.target.pane_id); } catch { alive = false; }

  if (alive) {
    // The event was spurious; treat it as a hint and let the caller keep waiting.
    addHint(store, d, 'pane_event_spurious', vanished.event);
    return SPURIOUS;
  }

  const fresh = loadDispatch(store, run.run_id, d.dispatch_id);
  addHint(store, fresh, 'pane_died', vanished.event, { confirmed: true });
  fresh.state = fresh.state === 'settled' ? fresh.state : 'abandoned';
  fresh.authority = false;
  saveDispatch(store, fresh, { event: 'dispatch.worker_vanished', pane_id: d.target.pane_id });

  // The TASK is deliberately left `dispatched`. cbds knows the attempt died; it does
  // not know whether the work succeeded. Deciding that is the orchestrator's call.
  const err = new CbdsError('worker_vanished',
    `pane ${d.target.pane_id} closed before dispatch ${d.dispatch_id} reported`, {
      exit: EXIT.WORKER_VANISHED,
      details: {
        dispatch_id: d.dispatch_id, task_id: d.task_id, pane_id: d.target.pane_id,
        elapsed_ms: elapsed, collected: collected.length,
      },
      hint: `the attempt is dead, not the task. Retry with \`cbds dispatch start --task ${d.task_id} --retry-of ${d.dispatch_id}\``,
    });

  if (ctx.json) { emitErrorJson(ctx, err, { collected }); process.exitCode = EXIT.WORKER_VANISHED; return null; }
  say(ctx, `${c.red('worker vanished')}  pane ${c.bold(d.target.pane_id)} closed with no report`);
  say(ctx, c.dim(`  task ${d.task_id} stays 'dispatched' — cbds cannot know whether the work landed`));
  throw err;
};

const finish = (ctx, R, store, run, reports, meta) => {
  const acked = ctx.flags.ack ? reports.map((r) => markAcked(R, r)) : reports;

  if (!ctx.json) {
    say(ctx, `${c.green('report received')}${meta.immediate ? c.dim(' (already on disk)') : ` after ${duration(meta.elapsed)}`}`);
    for (const r of acked) {
      const type = messageType(r);
      say(ctx, '');
      say(ctx, `  ${type === 'report' ? paintState(r.outcome) : c.cyan(type)}  ${c.bold(r.subject ?? '(no subject)')}`);
      say(ctx, kv([
        ['task', r.task_id],
        ['dispatch', r.dispatch_id],
        ['reported', relTime(r.reported_at)],
        ['files', r.files_modified?.join(', ') || null],
        ['question', r.question],
        ['next steps', r.next_steps],
      ]));
      if (r.body) {
        say(ctx, `\n${r.body.split('\n').map((l) => `    ${l}`).join('\n')}`);
      }
      if (messageType(r) === 'question') {
        say(ctx, c.yellow(`\n    the worker is BLOCKED on this. Answer it:`));
        say(ctx, `    cbds reply --id ${r.report_id} --body "<answer>"`);
      }
      if (messageType(r) === 'escalation') {
        say(ctx, c.yellow('\n    the worker is still running and still owes a report.'));
      }
    }
    if (meta.pending?.length) {
      say(ctx, c.dim(`\n  still outstanding: ${meta.pending.map((d) => d.dispatch_id).join(', ')}`));
    }
    say(ctx, c.dim(`\n  next: cbds release ${acked[0]?.dispatch_id ?? '<dispatch_id>'}`));
  }

  return emit(ctx, {
    status: meta.status,
    scope: meta.scopeLabel,
    elapsed_ms: meta.elapsed,
    count: acked.length,
    reports: acked,
    outstanding: (meta.pending ?? []).map((d) => ({
      dispatch_id: d.dispatch_id, task_id: d.task_id, pane_id: d.target.pane_id,
    })),
  });
};
