import { csv, requireFlag, oneOf } from '../core/args.mjs';
import { conflict, notFound, usage } from '../core/errors.mjs';
import { emit, say, table, kv, c, paintState, relTime, truncate } from '../core/output.mjs';
import { loadTask, saveTask, listTasks, SCHEMA_VERSION } from '../core/model.mjs';
import { resolveRun, resolveTaskId } from '../core/context.mjs';
import { newGateId } from '../core/ids.mjs';
import { nowIso, readJson, writeJsonAtomic, listJsonIds, appendEvent } from '../core/store.mjs';

/**
 * Decision gates: a coordinator-owned question that blocks a task until answered.
 *
 * The mirror image of `cbds ask`. `ask` is worker-initiated — a worker mid-task needs
 * an answer to continue. A gate is coordinator-initiated and exists *before* the work
 * starts: it is how a plan expresses "this branch of the DAG is undecided, do not
 * dispatch it yet". Without one, a coordinator has to hold that state in its own head,
 * and it evaporates the moment it crashes or its context is compacted.
 *
 * An open gate makes its task undispatchable. That is enforced in `dispatch start`,
 * not merely displayed, so a plan cannot accidentally run past an unmade decision.
 */

const GATE_STATES = ['open', 'resolved', 'cancelled'];

const loadGate = (store, runId, gateId) => {
  const data = readJson(store.run(runId).gate(gateId), { optional: true });
  if (!data) throw notFound('gate', gateId);
  return data;
};

const listGates = (store, runId) =>
  listJsonIds(store.run(runId).gates)
    .map((id) => readJson(store.run(runId).gate(id), { optional: true }))
    .filter(Boolean);

/** Every open gate blocking a task. Used by `dispatch start` as a hard precondition. */
export const openGatesForTask = (store, runId, taskId) =>
  listGates(store, runId).filter((g) => g.task_id === taskId && g.state === 'open');

export const create = {
  summary: 'Open a decision gate that blocks a task until you resolve it',
  usage: 'cbds gate create --task <task_id> --question <text> [--options a,b]',
  flags: {
    task: { type: 'string', placeholder: 'task_id', describe: 'the task to block' },
    question: { type: 'string', describe: 'the decision to be made' },
    options: { type: 'string', placeholder: 'csv', describe: 'the choices' },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const taskId = resolveTaskId(store, run.run_id, requireFlag(ctx.flags, 'task', 'cbds gate create --task <task_id>'));
    const task = loadTask(store, run.run_id, taskId);
    const question = requireFlag(ctx.flags, 'question', 'what has to be decided before this task can run');

    if (['completed', 'cancelled'].includes(task.state)) {
      throw conflict('task_terminal', `task ${taskId} is ${task.state}; there is nothing left to gate`);
    }

    const gate = {
      schema_version: SCHEMA_VERSION,
      kind: 'gate',
      gate_id: newGateId(),
      run_id: run.run_id,
      task_id: taskId,
      question,
      options: csv(ctx.flags.options),
      state: 'open',
      resolution: null,
      created_at: nowIso(),
      resolved_at: null,
    };
    writeJsonAtomic(store.run(run.run_id).gate(gate.gate_id), gate);

    // The task is parked, not failed. `blocked` is the state that already means
    // "waiting on something outside the worker".
    if (['pending', 'ready'].includes(task.state)) {
      const before = task.state;
      task.state = 'blocked';
      saveTask(store, task, { event: 'task.gated', gate_id: gate.gate_id, from: before });
    }
    appendEvent(store.run(run.run_id).events, { event: 'gate.created', gate_id: gate.gate_id, task_id: taskId });

    say(ctx, `${c.magenta('gate opened')}  ${c.bold(gate.gate_id)}`);
    say(ctx, kv([
      ['task', `${taskId}  ${truncate(task.title, 40)} ${c.dim('->')} ${paintState(task.state)}`],
      ['question', question],
      ['options', gate.options.join(' | ') || null],
    ]));
    say(ctx, c.dim(`\n  the task cannot be dispatched until you run:`));
    say(ctx, `    cbds gate resolve ${gate.gate_id} --resolution "<choice>"`);
    return emit(ctx, gate);
  },
};

export const list = {
  summary: 'List decision gates',
  usage: 'cbds gate list [--task <id>] [--state open|resolved|cancelled]',
  flags: {
    task: { type: 'string', placeholder: 'task_id', describe: 'filter by task' },
    state: { type: 'string', describe: `filter: ${GATE_STATES.join('|')}` },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    let gates = listGates(store, run.run_id);
    if (ctx.flags.task) {
      const id = resolveTaskId(store, run.run_id, ctx.flags.task);
      gates = gates.filter((g) => g.task_id === id);
    }
    if (ctx.flags.state) {
      oneOf(ctx.flags.state, GATE_STATES, 'state');
      gates = gates.filter((g) => g.state === ctx.flags.state);
    }
    gates.sort((a, b) => a.created_at.localeCompare(b.created_at));

    say(ctx, table(gates, [
      { header: 'GATE', get: (g) => c.bold(g.gate_id) },
      { header: 'STATE', get: (g) => (g.state === 'open' ? c.magenta('open') : c.dim(g.state)) },
      { header: 'TASK', get: (g) => g.task_id },
      { header: 'AGE', get: (g) => relTime(g.created_at) },
      { header: 'QUESTION', get: (g) => truncate(g.question, 44) },
      { header: 'RESOLUTION', get: (g) => g.resolution ?? c.dim('—') },
    ]));
    return emit(ctx, { run_id: run.run_id, count: gates.length, gates });
  },
};

export const resolve = {
  summary: 'Resolve a gate and unblock its task',
  usage: 'cbds gate resolve <gate_id> --resolution <text>',
  flags: { resolution: { type: 'string', describe: 'the decision' } },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const id = ctx.flags.id ?? ctx.positional[0];
    if (!id) throw usage('cbds gate resolve <gate_id> --resolution "<choice>"');
    const gate = loadGate(store, run.run_id, id);
    if (gate.state !== 'open') {
      throw conflict('gate_not_open', `gate ${gate.gate_id} is already ${gate.state}`);
    }
    const resolution = requireFlag(ctx.flags, 'resolution', 'the decision the workers should follow');
    if (gate.options.length && !gate.options.includes(resolution)) {
      throw usage(`"${resolution}" is not one of the gate's options`,
        `options: ${gate.options.join(', ')} — or reopen the gate with a different question`);
    }

    gate.state = 'resolved';
    gate.resolution = resolution;
    gate.resolved_at = nowIso();
    writeJsonAtomic(store.run(run.run_id).gate(gate.gate_id), gate);

    // Only lift the block once NO open gate remains; a task can be gated more than once.
    const task = loadTask(store, run.run_id, gate.task_id);
    const stillOpen = openGatesForTask(store, run.run_id, gate.task_id);
    if (!stillOpen.length && task.state === 'blocked') {
      task.state = 'ready';
      saveTask(store, task, { event: 'task.ungated', gate_id: gate.gate_id });
    }
    appendEvent(store.run(run.run_id).events, { event: 'gate.resolved', gate_id: gate.gate_id, resolution });

    say(ctx, `${c.green('gate resolved')}  ${c.bold(gate.gate_id)}  ${c.dim('->')} ${c.bold(resolution)}`);
    say(ctx, kv([
      ['task', `${task.task_id} ${c.dim('->')} ${paintState(task.state)}`],
      ['still gated by', stillOpen.map((g) => g.gate_id).join(', ') || null],
    ]));
    if (task.state === 'ready') {
      say(ctx, c.dim(`\n  next: cbds dispatch start --task ${task.task_id}`));
      say(ctx, c.dim('  the decision is NOT auto-injected — put it in the task spec if the worker needs it:'));
      say(ctx, c.dim(`    cbds task update ${task.task_id} --spec "<spec + decision: ${resolution}>"`));
    }
    return emit(ctx, { gate, task, still_open: stillOpen });
  },
};

export const cancel = {
  summary: 'Cancel a gate without deciding it',
  usage: 'cbds gate cancel <gate_id>',
  flags: { reason: { type: 'string', describe: 'why' } },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const id = ctx.positional[0];
    if (!id) throw usage('cbds gate cancel <gate_id>');
    const gate = loadGate(store, run.run_id, id);
    gate.state = 'cancelled';
    gate.resolution = null;
    gate.resolved_at = nowIso();
    gate.cancel_reason = ctx.flags.reason ?? null;
    writeJsonAtomic(store.run(run.run_id).gate(gate.gate_id), gate);

    const task = loadTask(store, run.run_id, gate.task_id);
    if (!openGatesForTask(store, run.run_id, gate.task_id).length && task.state === 'blocked') {
      task.state = 'ready';
      saveTask(store, task, { event: 'task.ungated', gate_id: gate.gate_id, cancelled: true });
    }
    say(ctx, `${c.yellow('gate cancelled')}  ${c.bold(gate.gate_id)}  task ${task.task_id} ${c.dim('->')} ${paintState(task.state)}`);
    return emit(ctx, { gate, task });
  },
};
