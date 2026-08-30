import fs from 'node:fs';
import { requireFlag } from '../core/args.mjs';
import { conflict } from '../core/errors.mjs';
import { emit, say, kv, c, paintState } from '../core/output.mjs';
import { loadDispatch, saveDispatch, loadTask } from '../core/model.mjs';
import { resolveRun, resolveDispatchId } from '../core/context.mjs';
import { ensureDir, nowIso } from '../core/store.mjs';
import { agentRead, paneRead, paneClose, clearPanePaint } from '../herdr/client.mjs';

/**
 * Post-completion cleanup, mirroring Orca's release/retain split.
 *
 * Release is NOT cancellation: it only ever touches a settled dispatch, it captures
 * the transcript before closing anything, and it refuses to close a pane cbds did not
 * create. A released worker stays fully readable through its saved transcript.
 */
export const release = {
  summary: 'Close a settled dispatch’s pane, preserving its transcript first',
  usage: 'cbds release <dispatch_id> [--force] [--keep-pane]',
  flags: {
    force: { type: 'boolean', describe: 'release even if the dispatch has not settled' },
    'keep-pane': { type: 'boolean', describe: 'capture the transcript but leave the pane open' },
    lines: { type: 'number', default: 2000, describe: 'transcript lines to capture' },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const R = store.run(run.run_id);
    const id = resolveDispatchId(store, run.run_id, requireFlag({ id: ctx.positional[0] }, 'id', 'cbds release <dispatch_id>'));
    const dispatch = loadDispatch(store, run.run_id, id);

    if (dispatch.released) {
      say(ctx, c.dim(`dispatch ${id} was already released`));
      return emit(ctx, dispatch);
    }
    if (dispatch.state === 'dispatched' && !ctx.flags.force) {
      throw conflict('dispatch_not_settled',
        `dispatch ${id} has not settled (state: ${dispatch.state})`,
        'release is post-completion cleanup, not cancellation. Wait for the report, or use --force if the worker is confirmed dead.');
    }
    if (dispatch.retained && !ctx.flags.force) {
      throw conflict('dispatch_retained',
        `dispatch ${id} was explicitly retained: ${dispatch.retain_reason ?? 'no reason recorded'}`,
        'pass --force to release it anyway');
    }

    /* ---- preserve output BEFORE closing anything ---- */

    let transcript = null;
    let transcriptPath = null;
    const paneId = dispatch.target?.pane_id;
    if (paneId) {
      for (const read of [
        () => agentRead(dispatch.target.agent_name, { lines: ctx.flags.lines }),
        () => paneRead(paneId, { lines: ctx.flags.lines }),
      ]) {
        try {
          // `pane read` / `agent read` return raw terminal text, not a JSON envelope.
          const res = await read();
          transcript = typeof res === 'string' ? res : (res?.content ?? res?.text ?? null);
          if (transcript && transcript.trim()) break;
        } catch { /* try the next source */ }
      }
      if (transcript) {
        ensureDir(R.transcripts);
        transcriptPath = R.transcript(dispatch.dispatch_id);
        fs.writeFileSync(transcriptPath, transcript);
      }
    }

    /* ---- close only a pane cbds created ---- */

    let closed = false;
    let closeReason = null;
    if (ctx.flags['keep-pane']) {
      closeReason = 'kept by --keep-pane';
    } else if (!dispatch.target?.supervised) {
      closeReason = 'unsupervised: cbds did not create this pane';
    } else if (!paneId) {
      closeReason = 'no pane recorded';
    } else {
      try {
        await clearPanePaint(paneId);
        await paneClose(paneId);
        closed = true;
      } catch (err) {
        closeReason = `close failed: ${err.code ?? err.message}`;
      }
    }

    dispatch.released = true;
    dispatch.released_at = nowIso();
    dispatch.transcript_path = transcriptPath;
    if (dispatch.state !== 'settled') { dispatch.state = 'abandoned'; dispatch.authority = false; }
    saveDispatch(store, dispatch, { event: 'dispatch.released', closed, reason: closeReason });

    say(ctx, `${c.green('released')}  ${c.bold(id)}`);
    say(ctx, kv([
      ['pane', closed ? `${paneId} ${c.dim('(closed)')}` : `${paneId ?? '—'} ${c.dim(`(retained: ${closeReason})`)}`],
      ['transcript', transcriptPath ?? c.dim('none captured')],
      ['outcome', dispatch.outcome ? paintState(dispatch.outcome) : null],
    ]));
    return emit(ctx, { dispatch, closed, close_reason: closeReason, transcript_path: transcriptPath });
  },
};

export const retain = {
  summary: 'Record an explicit exception keeping a settled worker’s pane alive',
  usage: 'cbds retain <dispatch_id> --reason <text>',
  flags: { reason: { type: 'string', describe: 'why this pane must stay open' } },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const id = resolveDispatchId(store, run.run_id, requireFlag({ id: ctx.positional[0] }, 'id', 'cbds retain <dispatch_id>'));
    const dispatch = loadDispatch(store, run.run_id, id);
    dispatch.retained = true;
    dispatch.retain_reason = ctx.flags.reason ?? 'requested by the user';
    dispatch.retained_at = nowIso();
    saveDispatch(store, dispatch, { event: 'dispatch.retained', reason: dispatch.retain_reason });

    say(ctx, `${c.yellow('retained')}  ${c.bold(id)}  pane ${dispatch.target?.pane_id ?? '—'} stays open`);
    say(ctx, c.dim(`  reason: ${dispatch.retain_reason}`));
    say(ctx, c.dim(`  when finished: cbds release ${id}`));
    return emit(ctx, dispatch);
  },
};
