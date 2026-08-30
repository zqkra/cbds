import fs from 'node:fs';
import os from 'node:os';
import { CbdsError, EXIT, notFound, conflict } from './errors.mjs';
import { newRunId, newTaskId, newDispatchId } from './ids.mjs';
import { nowIso, readJson, writeJsonAtomic, listJsonIds, appendEvent } from './store.mjs';

export const SCHEMA_VERSION = 1;

export const TASK_STATES = ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked', 'cancelled'];
export const TERMINAL_TASK_STATES = new Set(['completed', 'cancelled']);
export const DISPATCH_STATES = ['starting', 'dispatched', 'settled', 'superseded', 'abandoned'];
export const OUTCOMES = ['succeeded', 'failed', 'blocked'];

/** outcome -> the task state it produces. This is the only path into a terminal task state. */
export const OUTCOME_TO_TASK_STATE = {
  succeeded: 'completed',
  failed: 'failed',
  blocked: 'blocked',
};

// Explicit adjacency. Anything not listed is rejected, so an operator cannot flip a
// task to `completed` by hand and desynchronise it from the report record.
const TASK_TRANSITIONS = {
  pending: ['ready', 'cancelled', 'blocked'],
  ready: ['pending', 'dispatched', 'cancelled', 'blocked'],
  dispatched: ['completed', 'failed', 'blocked', 'cancelled', 'ready'],
  failed: ['ready', 'dispatched', 'cancelled'],
  blocked: ['ready', 'pending', 'dispatched', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const canTransitionTask = (from, to) => from === to || (TASK_TRANSITIONS[from] ?? []).includes(to);

export const assertTaskTransition = (task, to) => {
  if (!TASK_STATES.includes(to)) {
    throw new CbdsError('bad_state', `unknown task state: ${to}`, {
      exit: EXIT.USAGE, hint: `valid: ${TASK_STATES.join(', ')}`,
    });
  }
  if (!canTransitionTask(task.state, to)) {
    throw conflict('illegal_transition',
      `task ${task.task_id} cannot move ${task.state} -> ${to}`,
      TERMINAL_TASK_STATES.has(task.state) ? `${task.state} is terminal` : null);
  }
};

const caller = () => ({
  pane_id: process.env.HERDR_PANE_ID ?? null,
  workspace_id: process.env.HERDR_WORKSPACE_ID ?? null,
  tab_id: process.env.HERDR_TAB_ID ?? null,
  host: os.hostname(),
  pid: process.pid,
});

/* ------------------------------------------------------------------ runs -- */

export const createRun = (store, { objective, labels = {} }) => {
  if (!objective || !objective.trim()) {
    throw new CbdsError('missing_objective', 'a run needs --objective', { exit: EXIT.USAGE });
  }
  const run = {
    schema_version: SCHEMA_VERSION,
    kind: 'run',
    run_id: newRunId(),
    objective: objective.trim(),
    state: 'open',
    project_root: store.projectRoot ?? null,
    labels,
    created_at: nowIso(),
    closed_at: null,
    created_by: caller(),
  };
  const R = store.run(run.run_id);
  writeJsonAtomic(R.run, run);
  writeJsonAtomic(R.cursor, { schema_version: SCHEMA_VERSION, acked_seq: 0 });
  appendEvent(R.events, { event: 'run.created', run_id: run.run_id, by: caller() });
  return run;
};

export const loadRun = (store, runId) => {
  const data = readJson(store.run(runId).run, { optional: true });
  if (!data) throw notFound('run', runId);
  return data;
};

export const saveRun = (store, run) => writeJsonAtomic(store.run(run.run_id).run, run);

export const listRuns = (store) => {
  let ids = [];
  try { ids = fs.readdirSync(store.runs).filter((d) => d.startsWith('run_')); } catch { return []; }
  return ids
    .map((id) => readJson(store.run(id).run, { optional: true }))
    .filter(Boolean)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
};

/* ----------------------------------------------------------------- tasks -- */

export const createTask = (store, run, { spec, title = null, deps = [], parentId = null, priority = 0, maxAttempts = 3 }) => {
  if (!spec || !spec.trim()) {
    throw new CbdsError('missing_spec', 'a task needs --spec', { exit: EXIT.USAGE });
  }
  if (run.state !== 'open') {
    throw conflict('run_closed', `run ${run.run_id} is closed`, 'reopen is deliberately unsupported; create a new run');
  }
  const R = store.run(run.run_id);
  for (const dep of deps) {
    if (!readJson(R.task(dep), { optional: true })) throw notFound('task', dep);
  }
  const task = {
    schema_version: SCHEMA_VERSION,
    kind: 'task',
    task_id: newTaskId(),
    run_id: run.run_id,
    title: title?.trim() || spec.trim().split('\n')[0].slice(0, 80),
    spec: spec.trim(),
    state: deps.length ? 'pending' : 'ready',
    deps,
    parent_id: parentId,
    priority,
    attempts: 0,
    max_attempts: maxAttempts,
    live_dispatch_id: null,
    dispatch_ids: [],
    result: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  writeJsonAtomic(R.task(task.task_id), task);
  appendEvent(R.events, { event: 'task.created', task_id: task.task_id, state: task.state });
  return task;
};

export const loadTask = (store, runId, taskId) => {
  const data = readJson(store.run(runId).task(taskId), { optional: true });
  if (!data) throw notFound('task', taskId);
  return data;
};

export const saveTask = (store, task, event = null) => {
  const R = store.run(task.run_id);
  task.updated_at = nowIso();
  writeJsonAtomic(R.task(task.task_id), task);
  if (event) appendEvent(R.events, { task_id: task.task_id, ...event });
  return task;
};

export const listTasks = (store, runId) =>
  listJsonIds(store.run(runId).tasks)
    .map((id) => readJson(store.run(runId).task(id), { optional: true }))
    .filter(Boolean);

/** A task is dispatchable when its state allows it and every dependency is completed. */
export const depsSatisfied = (store, task) => {
  if (!task.deps?.length) return true;
  return task.deps.every((dep) => {
    const d = readJson(store.run(task.run_id).task(dep), { optional: true });
    return d?.state === 'completed';
  });
};

/**
 * Recompute pending<->ready from dependency state. Called opportunistically; it never
 * touches a task that is dispatched or terminal, so it cannot race a live worker.
 */
export const reconcileTaskReadiness = (store, task) => {
  if (task.state !== 'pending' && task.state !== 'ready') return task;
  const want = depsSatisfied(store, task) ? 'ready' : 'pending';
  if (task.state !== want) {
    const from = task.state;
    task.state = want;
    saveTask(store, task, { event: 'task.readiness', from, to: want });
  }
  return task;
};

/* ------------------------------------------------------------- dispatches -- */

export const createDispatch = (store, task, target, { retryOf = null, preambleSha = null, supervised = true }) => {
  const R = store.run(task.run_id);
  const dispatch = {
    schema_version: SCHEMA_VERSION,
    kind: 'dispatch',
    dispatch_id: newDispatchId(),
    task_id: task.task_id,
    run_id: task.run_id,
    attempt: task.attempts + 1,
    retry_of: retryOf,
    state: 'starting',
    authority: true,
    target: { ...target, supervised },
    preamble_sha256: preambleSha,
    outcome: null,
    report_id: null,
    hints: [],
    started_at: nowIso(),
    settled_at: null,
    released: false,
    retained: false,
    created_by: caller(),
  };
  writeJsonAtomic(R.dispatch(dispatch.dispatch_id), dispatch);
  appendEvent(R.events, {
    event: 'dispatch.created',
    dispatch_id: dispatch.dispatch_id,
    task_id: task.task_id,
    pane_id: target.pane_id,
    attempt: dispatch.attempt,
  });
  return dispatch;
};

export const loadDispatch = (store, runId, dispatchId) => {
  const data = readJson(store.run(runId).dispatch(dispatchId), { optional: true });
  if (!data) throw notFound('dispatch', dispatchId);
  return data;
};

export const saveDispatch = (store, dispatch, event = null) => {
  const R = store.run(dispatch.run_id);
  writeJsonAtomic(R.dispatch(dispatch.dispatch_id), dispatch);
  if (event) appendEvent(R.events, { dispatch_id: dispatch.dispatch_id, ...event });
  return dispatch;
};

export const listDispatches = (store, runId) =>
  listJsonIds(store.run(runId).dispatches)
    .map((id) => readJson(store.run(runId).dispatch(id), { optional: true }))
    .filter(Boolean);

/** Hints are advisory. They are recorded for diagnosis and never change task state. */
export const addHint = (store, dispatch, kind, value, extra = {}) => {
  dispatch.hints = [...(dispatch.hints ?? []), { at: nowIso(), kind, value, ...extra }].slice(-50);
  return saveDispatch(store, dispatch);
};

/**
 * Revoke completion authority from a dispatch. This is the mechanism behind the
 * `stale_dispatch` rejection: once superseded, a dispatch can never settle its task.
 */
export const supersedeDispatch = (store, dispatch, reason) => {
  if (dispatch.state === 'settled') return dispatch;
  dispatch.state = 'superseded';
  dispatch.authority = false;
  return saveDispatch(store, dispatch, { event: 'dispatch.superseded', reason });
};
