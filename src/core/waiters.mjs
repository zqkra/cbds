import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Who is currently blocked in `cbds wait`.
 *
 * This exists to answer one question at report time: is anybody actually listening?
 *
 * A CLI cannot push into an agent's context. If the coordinator ends its turn instead
 * of blocking on `wait`, an accepted report lands on disk and nothing wakes anyone —
 * the run looks finished while the result sits unread. Herdr *can* push, via
 * `agent prompt`, so cbds delivers the report into the coordinator's pane. But only
 * when nobody is waiting: injecting a prompt into a coordinator that is already
 * blocked would answer it twice.
 */

const dir = (R) => path.join(R.base, 'waiters');
const file = (R, pid = process.pid) => path.join(dir(R), `${os.hostname()}-${pid}.json`);

const alive = (w) => {
  if (w.host !== os.hostname()) return true;   // another machine: assume live, do not push
  try { process.kill(w.pid, 0); return true; } catch { return false; }
};

export const register = (R, scope) => {
  const f = file(R);
  try {
    fs.mkdirSync(dir(R), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({
      pid: process.pid, host: os.hostname(), scope, at: new Date().toISOString(),
    }));
  } catch { /* a bookkeeping failure must never break a wait */ }
  return () => { try { fs.rmSync(f, { force: true }); } catch { /* already gone */ } };
};

/** Live waiters, pruning entries left by processes that died mid-wait. */
export const liveWaiters = (R) => {
  let names = [];
  try { names = fs.readdirSync(dir(R)).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const f = path.join(dir(R), name);
    let w = null;
    try { w = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* unreadable */ }
    if (w && alive(w)) out.push(w);
    else { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
  }
  return out;
};

export const someoneIsWaiting = (R) => liveWaiters(R).length > 0;
