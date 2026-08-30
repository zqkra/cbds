#!/usr/bin/env node
/**
 * Event hook for pane.closed / pane.exited.
 *
 * Records an advisory hint on any dispatch bound to that pane and revokes its
 * authority, so a `wait` started later fails fast instead of burning its full
 * timeout. This is a HINT path: it never settles a task and never sets an outcome.
 */
import fs from 'node:fs';
import path from 'node:path';
import { event, targetCwd, findStore } from './context.mjs';
import { resolveStateDir } from '../src/core/paths.mjs';
import { openStore } from '../src/core/store.mjs';
import { listRuns, listDispatches, saveDispatch, addHint } from '../src/core/model.mjs';
import { scanInbox } from '../src/core/inbox.mjs';

const ev = event();
const paneId = ev.pane_id ?? ev.data?.pane_id ?? ev.payload?.pane_id;
if (!paneId) process.exit(0);

const start = targetCwd();
const root = findStore(start) ?? start;
if (!fs.existsSync(path.join(root, '.cbds', 'VERSION'))) process.exit(0);

try {
  const { root: stateRoot } = resolveStateDir({ cwd: root });
  const store = openStore(stateRoot);

  for (const run of listRuns(store)) {
    for (const d of listDispatches(store, run.run_id)) {
      if (d.target?.pane_id !== paneId) continue;
      if (d.state !== 'dispatched') continue;

      // It may have reported microseconds before exiting. That report wins.
      const reported = scanInbox(store.run(run.run_id))
        .some((r) => r.dispatch_id === d.dispatch_id && r.acceptance?.accepted);
      if (reported) continue;

      addHint(store, d, 'pane_closed', ev.type ?? 'pane_closed', { source: 'herdr_event' });
      d.state = 'abandoned';
      d.authority = false;
      saveDispatch(store, d, { event: 'dispatch.pane_closed_hint', pane_id: paneId });
    }
  }
} catch {
  // Event hooks are best-effort. `cbds doctor` is the authoritative reconciler.
}
process.exit(0);
