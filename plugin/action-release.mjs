#!/usr/bin/env node
/**
 * Action: release the cbds worker occupying the invoking pane.
 *
 * Resolves the dispatch from the pane id rather than trusting any ambient state, and
 * refuses when the pane is not a cbds worker — a release action that guessed could
 * close a pane the user owns.
 */
import { targetCwd, findStore, contextPaneId } from './context.mjs';
import { main } from '../src/cli.mjs';
import { resolveStateDir } from '../src/core/paths.mjs';
import { openStore } from '../src/core/store.mjs';
import { listRuns, listDispatches } from '../src/core/model.mjs';

const start = targetCwd();
const root = findStore(start) ?? start;
process.chdir(root);

const paneId = contextPaneId();
if (!paneId) {
  process.stderr.write('cbds: no pane in the invocation context\n');
  process.exit(2);
}

const { root: stateRoot } = resolveStateDir({ cwd: root });
let store;
try { store = openStore(stateRoot); } catch (err) {
  process.stderr.write(`cbds: ${err.message}\n`);
  process.exit(3);
}

const hit = listRuns(store)
  .flatMap((run) => listDispatches(store, run.run_id))
  .filter((d) => d.target?.pane_id === paneId && !d.released)
  .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];

if (!hit) {
  process.stderr.write(`cbds: pane ${paneId} is not an unreleased cbds worker\n`);
  process.exit(3);
}

process.exit(await main(['release', hit.dispatch_id, '--run', hit.run_id]));
