import fs from 'node:fs';
import path from 'node:path';
import { emit, say, table, c, paintState, relTime } from '../core/output.mjs';
import { listRuns, listTasks, listDispatches, saveDispatch, saveTask, addHint } from '../core/model.mjs';
import { scanInbox, scanRejected } from '../core/inbox.mjs';
import { insideHerdr, herdrBin, herdrText, paneAlive, paneClose } from '../herdr/client.mjs';
import { nowIso } from '../core/store.mjs';

/**
 * Reconcile durable state against the live Herdr session.
 *
 * This is the recovery path after a Herdr restart, a crash, or a pane the user closed
 * by hand. It is conservative by construction: it may mark a DISPATCH abandoned,
 * because a missing pane proves the attempt is over — but it never touches TASK
 * outcome, because a missing pane proves nothing about whether the work landed.
 */
export const doctor = {
  summary: 'Check the store and reconcile dispatches against live Herdr panes',
  usage: 'cbds doctor [--fix]',
  flags: {
    fix: { type: 'boolean', describe: 'apply the reconciliations, not just report them' },
    'break-locks': { type: 'boolean', describe: 'remove stale lock directories' },
  },
  async run(ctx) {
    const findings = [];
    const add = (level, code, message, fix = null) => findings.push({ level, code, message, fix });

    /* ---- environment ---- */

    const herdrOk = insideHerdr();
    let herdrVersion = null;
    try {
      // `herdr status` prints a plain-text report, not a JSON envelope.
      const text = await herdrText(['status'], { timeoutMs: 8000 });
      herdrVersion = text.match(/server:[\s\S]*?version:\s*(\S+)/)?.[1]
        ?? text.match(/version:\s*(\S+)/)?.[1] ?? null;
    } catch { /* reported as a warning below */ }

    if (!herdrOk) {
      add('warn', 'not_in_herdr',
        'not running inside a Herdr pane (HERDR_ENV != 1): dispatch start will fail, but done/wait/report still work');
    }
    if (!herdrVersion && herdrOk) {
      add('warn', 'herdr_unreachable', `could not query ${herdrBin()} status`);
    }

    /* ---- store ---- */

    let store = null;
    try { store = ctx.store(); } catch (err) {
      add('error', 'no_store', err.message);
      return report(ctx, findings, { store: ctx.stateRoot, herdr: { inside: herdrOk, version: herdrVersion } });
    }

    const runs = listRuns(store);
    if (!runs.length) add('info', 'no_runs', 'the store has no runs yet');

    const reconciled = [];

    for (const run of runs) {
      const R = store.run(run.run_id);

      /* stale locks */
      if (fs.existsSync(R.lock)) {
        const age = Date.now() - fs.statSync(R.lock).mtimeMs;
        if (age > 30_000) {
          add('warn', 'stale_lock', `run ${run.run_id} has a lock held for ${Math.round(age / 1000)}s`,
            'cbds doctor --break-locks');
          if (ctx.flags['break-locks']) {
            try { fs.rmSync(R.lock, { recursive: true, force: true }); add('info', 'lock_broken', `removed ${R.lock}`); }
            catch (err) { add('error', 'lock_break_failed', err.message); }
          }
        }
      }

      /* quarantined files */
      for (const dir of [R.tasks, R.dispatches, R.inbox]) {
        let entries = [];
        try { entries = fs.readdirSync(dir); } catch { continue; }
        for (const f of entries.filter((x) => x.includes('.corrupt'))) {
          add('error', 'corrupt_state', `quarantined file: ${path.join(dir, f)}`);
        }
      }

      /* rejected reports are diagnostic gold: surface them */
      const rejected = scanRejected(R);
      if (rejected.length) {
        add('warn', 'rejected_reports',
          `run ${run.run_id} has ${rejected.length} rejected report(s) — a worker tried to complete a dispatch it no longer owned`,
          `cbds report list --rejected --run ${run.run_id}`);
      }

      /* zombie panes: a dead dispatch whose pane is still alive.
         doctor used to look only for the opposite case (a live dispatch whose pane is
         gone) and reported "nothing to report" while a half-started agent kept holding
         its Herdr agent name, making every retry fail with agent_start_failed. */
      const zombies = listDispatches(store, run.run_id)
        .filter((d) => ['abandoned', 'superseded'].includes(d.state))
        .filter((d) => d.target?.pane_id && d.target?.supervised && !d.released
          && d.launch_cleanup?.closed !== true);
      for (const d of zombies) {
        let alive = null;
        try { alive = await paneAlive(d.target.pane_id); } catch { alive = null; }
        if (alive !== true) continue;

        add('warn', 'zombie_pane',
          `pane ${d.target.pane_id} is still open for ${d.state} dispatch ${d.dispatch_id} and may be holding agent name "${d.target.agent_name}"`,
          'cbds doctor --fix');
        reconciled.push({ dispatch_id: d.dispatch_id, pane_id: d.target.pane_id, kind: 'zombie_pane' });

        if (ctx.flags.fix) {
          try {
            await paneClose(d.target.pane_id);
            d.launch_cleanup = { closed: true, reason: null, by: 'doctor' };
            d.released = true;
            saveDispatch(store, d, { event: 'dispatch.zombie_pane_closed', pane_id: d.target.pane_id });
            add('info', 'zombie_pane_closed', `closed ${d.target.pane_id}`);
          } catch (err) {
            add('error', 'zombie_pane_close_failed', `${d.target.pane_id}: ${err.message}`);
          }
        }
      }

      /* dispatches whose panes are gone */
      const dispatches = listDispatches(store, run.run_id).filter((d) => d.state === 'dispatched');
      for (const d of dispatches) {
        if (!d.target?.pane_id) continue;
        let alive = null;
        try { alive = await paneAlive(d.target.pane_id); } catch { alive = null; }
        if (alive === false) {
          const reports = scanInbox(R).filter((r) => r.dispatch_id === d.dispatch_id);
          if (reports.length) continue;    // it reported before dying; nothing to fix
          reconciled.push({ dispatch_id: d.dispatch_id, task_id: d.task_id, pane_id: d.target.pane_id });
          add('warn', 'orphan_dispatch',
            `dispatch ${d.dispatch_id} points at pane ${d.target.pane_id}, which no longer exists`,
            'cbds doctor --fix');

          if (ctx.flags.fix) {
            addHint(store, d, 'pane_missing', 'confirmed by doctor');
            d.state = 'abandoned';
            d.authority = false;
            d.reconciled_at = nowIso();
            saveDispatch(store, d, { event: 'dispatch.reconciled_abandoned', pane_id: d.target.pane_id });

            const task = listTasks(store, run.run_id).find((t) => t.task_id === d.task_id);
            if (task && task.live_dispatch_id === d.dispatch_id) {
              // The dispatch is dead; the task returns to the pool. Its outcome is
              // deliberately left unknown rather than guessed at.
              task.live_dispatch_id = null;
              task.state = task.attempts >= task.max_attempts ? 'failed' : 'ready';
              saveTask(store, task, { event: 'task.dispatch_reconciled', dispatch_id: d.dispatch_id });
            }
          }
        }
      }
    }

    return report(ctx, findings, {
      store: ctx.stateRoot,
      herdr: { inside: herdrOk, version: herdrVersion, bin: herdrBin() },
      runs: runs.length,
      reconciled,
      fixed: Boolean(ctx.flags.fix),
    });
  },
};

const report = (ctx, findings, meta) => {
  const level = findings.some((f) => f.level === 'error') ? 'error'
    : findings.some((f) => f.level === 'warn') ? 'warn' : 'ok';

  if (!ctx.json) {
    const badge = { ok: c.green('healthy'), warn: c.yellow('warnings'), error: c.red('problems') }[level];
    say(ctx, `${c.bold('cbds doctor')}  ${badge}`);
    say(ctx, `  ${c.dim('store')}  ${meta.store}`);
    say(ctx, `  ${c.dim('herdr')}  ${meta.herdr.inside ? c.green('inside a pane') : c.yellow('outside')}${meta.herdr.version ? c.dim(` · ${meta.herdr.version}`) : ''}`);
    say(ctx, '');
    if (!findings.length) {
      say(ctx, c.green('  nothing to report'));
    } else {
      say(ctx, table(findings, [
        {
          header: 'LEVEL',
          get: (f) => ({ error: c.red('error'), warn: c.yellow('warn'), info: c.dim('info') }[f.level]),
        },
        { header: 'CODE', get: (f) => f.code },
        { header: 'DETAIL', get: (f) => f.message },
      ]));
      const fixes = [...new Set(findings.map((f) => f.fix).filter(Boolean))];
      if (fixes.length && !meta.fixed) {
        say(ctx, `\n${c.dim('  suggested:')}`);
        for (const f of fixes) say(ctx, `    ${f}`);
      }
    }
    if (meta.reconciled?.length) {
      const z = meta.reconciled.filter((r) => r.kind === 'zombie_pane').length;
      const o = meta.reconciled.length - z;
      const bits = [o && `${o} orphaned dispatch(es)`, z && `${z} zombie pane(s)`].filter(Boolean).join(' and ');
      say(ctx, `\n  ${meta.fixed ? c.green('reconciled') : c.yellow('would reconcile')} ${bits}`);
    }
  }

  if (level === 'error') process.exitCode = 1;
  return emit(ctx, { level, findings, ...meta });
};
