import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { newReportId } from './ids.mjs';
import { SCHEMA_VERSION } from './model.mjs';
import { nowIso, readJson, writeJsonAtomic, withLock, ensureDir, appendEvent } from './store.mjs';

const pad = (n) => String(n).padStart(7, '0');

/** Monotonic per-run sequence, claimed under the run lock. Gives reports a FIFO order. */
const claimSeq = (R) => withLock(R.lock, () => {
  ensureDir(R.inbox);
  let current = 0;
  try { current = Number.parseInt(fs.readFileSync(R.seq, 'utf8').trim(), 10) || 0; } catch { current = 0; }
  const next = current + 1;
  fs.writeFileSync(R.seq, `${next}\n`);
  return next;
});

/**
 * Persist a report. Accepted reports land in inbox/, rejected ones in inbox/rejected/.
 * Rejected reports are kept deliberately: a zombie worker trying to complete a
 * superseded dispatch is diagnostic information, not noise to be dropped.
 */
export const writeReport = (R, report) => {
  const seq = claimSeq(R);
  const withSeq = { ...report, seq };
  const dir = report.acceptance?.accepted ? R.inbox : R.rejected;
  ensureDir(dir);
  const file = path.join(dir, `${pad(seq)}-${report.dispatch_id}.json`);
  writeJsonAtomic(file, withSeq);
  appendEvent(R.events, {
    event: report.acceptance?.accepted ? 'report.accepted' : 'report.rejected',
    report_id: report.report_id,
    dispatch_id: report.dispatch_id,
    task_id: report.task_id,
    outcome: report.outcome,
    reason: report.acceptance?.reason ?? null,
  });
  return { report: withSeq, file };
};

export const buildReport = ({ runId, taskId, dispatchId, outcome, subject, body, filesModified = [], artifacts = [], nextSteps = null, question = null }) => ({
  schema_version: SCHEMA_VERSION,
  kind: 'report',
  report_id: newReportId(),
  seq: null,
  run_id: runId,
  task_id: taskId,
  dispatch_id: dispatchId,
  outcome,
  subject: subject ?? null,
  body: body ?? null,
  files_modified: filesModified,
  artifacts,
  next_steps: nextSteps,
  question,
  reported_at: nowIso(),
  reported_from: {
    pane_id: process.env.HERDR_PANE_ID ?? null,
    host: os.hostname(),
    pid: process.pid,
  },
  acceptance: { accepted: false, reason: null, at: null },
  acked_at: null,
});

const readDirReports = (dir) => {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    // A file can vanish or be mid-rename between readdir and read; one retry covers it.
    let data = readJson(path.join(dir, f), { optional: true });
    if (!data) data = readJson(path.join(dir, f), { optional: true });
    if (data) out.push({ ...data, _file: path.join(dir, f) });
  }
  return out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
};

export const scanInbox = (R) => readDirReports(R.inbox);
export const scanRejected = (R) => readDirReports(R.rejected);

export const readCursor = (R) => readJson(R.cursor, { optional: true }) ?? { schema_version: SCHEMA_VERSION, acked_seq: 0 };

export const ackUpTo = (R, seq) => withLock(R.lock, () => {
  const cursor = readCursor(R);
  if (seq > cursor.acked_seq) {
    cursor.acked_seq = seq;
    writeJsonAtomic(R.cursor, cursor);
  }
  return cursor;
});

export const markAcked = (R, report) => {
  if (!report._file) return report;
  const updated = { ...report, acked_at: nowIso() };
  delete updated._file;
  writeJsonAtomic(report._file, updated);
  ackUpTo(R, report.seq);
  return updated;
};

/**
 * Block until a report satisfying `matches` exists, or the deadline passes.
 *
 * Correctness comes from re-scanning the durable inbox on every wake. fs.watch is a
 * latency optimisation and nothing more: if the platform coalesces or drops every
 * event (NFS, some containers, odd Windows cases), the safety poll still resolves the
 * wait, just more slowly. Losing notifications can never lose a result.
 */
export const waitForReport = async (R, {
  matches,
  timeoutMs,
  pollMs = 2000,
  signal = null,
  onTick = null,
} = {}) => {
  const deadline = Date.now() + timeoutMs;
  ensureDir(R.inbox);

  const scan = () => scanInbox(R).filter(matches);

  const found = scan();
  if (found.length) return { status: 'found', reports: found };

  return await new Promise((resolve) => {
    let settled = false;
    let watcher = null;
    let poll = null;
    let deadlineTimer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { watcher?.close(); } catch { /* already closed */ }
      if (poll) clearInterval(poll);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(value);
    };

    const check = () => {
      if (settled) return;
      let hits = [];
      try { hits = scan(); } catch { return; }   // a transient read error must not kill the wait
      if (hits.length) finish({ status: 'found', reports: hits });
      else onTick?.(Math.max(0, deadline - Date.now()));
    };

    function onAbort() { finish({ status: 'aborted', reports: [] }); }
    signal?.addEventListener?.('abort', onAbort, { once: true });

    try {
      watcher = fs.watch(R.inbox, { persistent: true }, () => setTimeout(check, 25));
      watcher.on('error', () => { watcher = null; });   // degrade to polling
    } catch { watcher = null; }

    poll = setInterval(check, Math.min(pollMs, Math.max(250, timeoutMs)));
    deadlineTimer = setTimeout(() => finish({ status: 'timeout', reports: [] }), Math.max(0, deadline - Date.now()));

    check();
  });
};
