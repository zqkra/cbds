import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const STORE_VERSION = '1';

/** Nearest ancestor holding a .git entry, else the starting directory. */
export const findProjectRoot = (start = process.cwd()) => {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
};

const globalBase = () => {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'cbds');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'cbds');
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'cbds');
};

const slug = (p) =>
  (path.basename(p) || 'project').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40) || 'project';

/**
 * Resolution order, highest priority first:
 *   1. explicit --state-dir
 *   2. $CBDS_STATE_DIR   (this is what the worker preamble injects, so `cbds done`
 *      resolves the same store from any cwd inside the pane)
 *   3. --global          -> per-user state dir keyed by project path
 *   4. <project root>/.cbds   (default: visible, greppable, disposable)
 */
export const resolveStateDir = ({ stateDir = null, global = false, cwd = process.cwd() } = {}) => {
  const projectRoot = findProjectRoot(cwd);
  if (stateDir) return { root: path.resolve(stateDir), projectRoot };
  if (process.env.CBDS_STATE_DIR) {
    return { root: path.resolve(process.env.CBDS_STATE_DIR), projectRoot };
  }
  if (global) {
    const digest = createHash('sha256').update(projectRoot).digest('hex').slice(0, 8);
    return { root: path.join(globalBase(), `${slug(projectRoot)}-${digest}`), projectRoot };
  }
  return { root: path.join(projectRoot, '.cbds'), projectRoot };
};

export const layout = (root) => ({
  root,
  version: path.join(root, 'VERSION'),
  config: path.join(root, 'config.json'),
  activeRun: path.join(root, 'active-run'),
  runs: path.join(root, 'runs'),
  run: (runId) => {
    const base = path.join(root, 'runs', runId);
    return {
      base,
      run: path.join(base, 'run.json'),
      tasks: path.join(base, 'tasks'),
      task: (id) => path.join(base, 'tasks', `${id}.json`),
      dispatches: path.join(base, 'dispatches'),
      dispatch: (id) => path.join(base, 'dispatches', `${id}.json`),
      inbox: path.join(base, 'inbox'),
      rejected: path.join(base, 'inbox', 'rejected'),
      seq: path.join(base, 'inbox', '.seq'),
      cursor: path.join(base, 'cursor.json'),
      lock: path.join(base, 'seq.lock'),
      transcripts: path.join(base, 'transcripts'),
      transcript: (id) => path.join(base, 'transcripts', `${id}.txt`),
      events: path.join(base, 'events.log'),
    };
  },
});
