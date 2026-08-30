import fs from 'node:fs';
import { CbdsError, EXIT, notFound } from './errors.mjs';
import { resolveStateDir } from './paths.mjs';
import { openStore, ensureDir } from './store.mjs';
import { loadRun, listRuns } from './model.mjs';

/**
 * Everything a command needs: the opened store, the bound run, and the global flags.
 * Built once per invocation so no command re-derives paths.
 */
export const buildContext = ({ commandName, flags, positional }) => {
  const { root, projectRoot } = resolveStateDir({
    stateDir: flags['state-dir'],
    global: flags.global,
  });
  return {
    commandName,
    flags,
    positional,
    json: Boolean(flags.json),
    quiet: Boolean(flags.quiet),
    stateRoot: root,
    projectRoot,
    _store: null,

    store(create = false) {
      if (!this._store) {
        this._store = { ...openStore(root, { create }), projectRoot };
      }
      return this._store;
    },
  };
};

export const readActiveRunId = (store) => {
  try { return fs.readFileSync(store.activeRun, 'utf8').trim() || null; } catch { return null; }
};

export const writeActiveRunId = (store, runId) => {
  ensureDir(store.root);
  fs.writeFileSync(store.activeRun, `${runId}\n`);
  return runId;
};

/**
 * Resolve which run a command operates on, in priority order:
 *   --run > $CBDS_RUN_ID (worker env) > the bound active run > the only open run.
 *
 * The last rule is a deliberate convenience: with exactly one open run, an
 * orchestrator should not have to thread --run through every call. With two or more
 * it becomes ambiguous and cbds refuses rather than guessing.
 */
export const resolveRun = (ctx, { required = true, create = false } = {}) => {
  const store = ctx.store(create);
  const explicit = ctx.flags.run || process.env.CBDS_RUN_ID || readActiveRunId(store);
  if (explicit) return loadRun(store, explicit);

  const open = listRuns(store).filter((r) => r.state === 'open');
  if (open.length === 1) return open[0];
  if (!required) return null;
  if (open.length === 0) {
    throw new CbdsError('no_run', 'no open run in this project', {
      exit: EXIT.NOT_FOUND,
      hint: 'create one with `cbds run create --objective "<what this run is for>"`',
    });
  }
  throw new CbdsError('ambiguous_run', `${open.length} open runs; pick one with --run`, {
    exit: EXIT.USAGE,
    details: { open_runs: open.map((r) => ({ run_id: r.run_id, objective: r.objective })) },
    hint: 'or bind one for this project with `cbds run use <run_id>`',
  });
};

/** Resolve a task by full id or by unique suffix, so humans can retype less. */
export const resolveTaskId = (store, runId, needle) => {
  const R = store.run(runId);
  let files = [];
  try { files = fs.readdirSync(R.tasks).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); }
  catch { throw notFound('task', needle); }
  if (files.includes(needle)) return needle;
  const hits = files.filter((id) => id.endsWith(needle) || id.includes(needle));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new CbdsError('ambiguous_task', `"${needle}" matches ${hits.length} tasks`, {
      exit: EXIT.USAGE, details: { matches: hits },
    });
  }
  throw notFound('task', needle);
};

export const resolveDispatchId = (store, runId, needle) => {
  const R = store.run(runId);
  let files = [];
  try { files = fs.readdirSync(R.dispatches).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); }
  catch { throw notFound('dispatch', needle); }
  if (files.includes(needle)) return needle;
  const hits = files.filter((id) => id.endsWith(needle) || id.includes(needle));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    throw new CbdsError('ambiguous_dispatch', `"${needle}" matches ${hits.length} dispatches`, {
      exit: EXIT.USAGE, details: { matches: hits },
    });
  }
  throw notFound('dispatch', needle);
};
