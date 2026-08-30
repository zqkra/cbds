import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CbdsError, EXIT } from './errors.mjs';
import { STORE_VERSION, layout } from './paths.mjs';

const LOCK_STALE_MS = 30_000;

export const nowIso = () => new Date().toISOString();

export const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * Write-to-temp + fsync + rename. A reader therefore never observes a half-written
 * file: it sees either the old bytes or the new ones. This is the single mechanism
 * that lets readers run without any lock.
 */
export const writeJsonAtomic = (file, value) => {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(tmp, 'wx', 0o644);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // fsync the directory too, so the rename itself survives a power cut on ext4/xfs.
  try {
    const dfd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* directory fsync is unavailable on Windows; the rename is still atomic */ }
};

export const readJson = (file, { optional = false } = {}) => {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (optional) return null;
      throw new CbdsError('missing_file', `state file not found: ${file}`, { exit: EXIT.NOT_FOUND });
    }
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Quarantine rather than guess. A corrupt entity must fail loudly: silently
    // treating it as absent could resurrect a settled task.
    const quarantine = `${file}.corrupt.${Date.now()}`;
    try { fs.renameSync(file, quarantine); } catch { /* best effort */ }
    throw new CbdsError('corrupt_state', `corrupt JSON quarantined to ${quarantine}`, {
      exit: EXIT.FAILURE,
      hint: 'run `cbds doctor` to inspect the store',
    });
  }
};

/**
 * Cross-platform mutex. mkdir is atomic on POSIX and on Windows, which is why it
 * beats lockfiles here: no O_EXCL semantics to worry about, no partial state.
 */
export class Lock {
  constructor(dir) {
    this.dir = dir;
    this.held = false;
  }

  #ownerFile() { return path.join(this.dir, 'owner.json'); }

  #breakIfStale() {
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(this.#ownerFile(), 'utf8')); } catch { /* unreadable */ }
    let age = Infinity;
    try { age = Date.now() - fs.statSync(this.dir).mtimeMs; } catch { return false; }

    // Same host and the process is demonstrably alive -> respect the lock regardless of age.
    if (owner && owner.host === os.hostname() && owner.pid) {
      try { process.kill(owner.pid, 0); return false; } catch { /* dead: fall through */ }
    }
    if (age < LOCK_STALE_MS) return false;
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
      return true;
    } catch { return false; }
  }

  acquire({ timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    ensureDir(path.dirname(this.dir));
    for (;;) {
      try {
        fs.mkdirSync(this.dir);
        fs.writeFileSync(this.#ownerFile(), JSON.stringify({ pid: process.pid, host: os.hostname(), at: nowIso() }));
        this.held = true;
        return this;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        if (this.#breakIfStale()) continue;
        if (Date.now() > deadline) {
          throw new CbdsError('lock_timeout', `could not acquire ${this.dir} within ${timeoutMs}ms`, {
            exit: EXIT.CONFLICT,
            hint: 'another cbds process is mutating this run; retry, or `cbds doctor --json` to inspect',
          });
        }
        // Busy-wait with a short sleep. Atomics.wait is the only synchronous sleep
        // Node offers, and these holds are measured in single-digit milliseconds.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
  }

  release() {
    if (!this.held) return;
    this.held = false;
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

export const withLock = (dir, fn, opts) => {
  const lock = new Lock(dir).acquire(opts);
  try { return fn(); } finally { lock.release(); }
};

/** Append-only audit trail. One JSON object per line, O_APPEND so concurrent writes interleave cleanly. */
export const appendEvent = (file, event) => {
  ensureDir(path.dirname(file));
  try {
    fs.appendFileSync(file, `${JSON.stringify({ at: nowIso(), ...event })}\n`);
  } catch { /* the audit log must never break a real operation */ }
};

export const readEvents = (file, limit = 200) => {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).slice(-limit).map((line) => {
    try { return JSON.parse(line); } catch { return { at: null, raw: line }; }
  });
};

/** Open (and lazily create) the store, refusing a format we do not understand. */
export const openStore = (root, { create = false } = {}) => {
  const L = layout(root);
  if (!fs.existsSync(L.version)) {
    if (!create) {
      throw new CbdsError('no_store', `no cbds store at ${root}`, {
        exit: EXIT.NOT_FOUND,
        hint: 'run `cbds run create --objective "<what this run is for>"` to initialise one',
      });
    }
    ensureDir(root);
    ensureDir(L.runs);
    fs.writeFileSync(L.version, `${STORE_VERSION}\n`);
    if (!fs.existsSync(L.config)) {
      writeJsonAtomic(L.config, {
        schema_version: 1,
        default_agent: 'claude',
        poll_ms: 2000,
        max_depth: 1,
        startup_timeout_ms: 60_000,
      });
    }
  }
  const found = fs.readFileSync(L.version, 'utf8').trim();
  if (found !== STORE_VERSION) {
    throw new CbdsError('store_version_mismatch',
      `store at ${root} is format v${found}, this cbds speaks v${STORE_VERSION}`, {
        exit: EXIT.CONFLICT,
        hint: 'upgrade cbds, or point --state-dir at a compatible store',
      });
  }
  return { ...L, config: readJson(L.config, { optional: true }) ?? {}, configPath: L.config };
};

export const listJsonIds = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  } catch { return []; }
};
