#!/usr/bin/env node
/**
 * Startup hook: after Herdr restores a session, pane ids may point at panes that no
 * longer exist. Reconcile so the board and `wait` do not chase ghosts.
 *
 * Deliberately conservative: it only ever marks a DISPATCH abandoned. Task outcome is
 * never inferred, because a missing pane says nothing about whether the work landed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { targetCwd, findStore } from './context.mjs';
import { main } from '../src/cli.mjs';

const start = targetCwd();
const root = findStore(start) ?? start;

if (!fs.existsSync(path.join(root, '.cbds', 'VERSION'))) {
  process.exit(0);   // nothing to reconcile; a no-op startup must never fail the server
}

process.chdir(root);
try {
  await main(['doctor', '--fix', '--break-locks', '--json', '--quiet']);
} catch {
  // A failing startup hook must not stop Herdr. Problems surface in `cbds doctor`.
}
process.exit(0);
