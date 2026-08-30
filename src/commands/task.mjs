import fs from 'node:fs';
import { csv, requireFlag, oneOf } from '../core/args.mjs';
import { conflict, usage } from '../core/errors.mjs';
import { emit, say, table, kv, c, paintState, relTime, truncate } from '../core/output.mjs';
import {
  createTask, loadTask, saveTask, listTasks, listDispatches,
  reconcileTaskReadiness, depsSatisfied, assertTaskTransition,
  supersedeDispatch, loadDispatch, TASK_STATES,
} from '../core/model.mjs';
import { resolveRun, resolveTaskId } from '../core/context.mjs';

const readSpec = (flags) => {
  if (flags['spec-file']) return fs.readFileSync(flags['spec-file'], 'utf8');
  return flags.spec;
};

export const create = {
  summary: 'Create a task in the active run',
  usage: 'cbds task create --spec <text> [--title <t>] [--deps <ids>]',
  flags: {
    spec: { type: 'string', describe: 'the work, in full' },
    'spec-file': { type: 'string', placeholder: 'path', describe: 'read the spec from a file' },
    title: { type: 'string', describe: 'short label (default: first line of spec)' },
    deps: { type: 'string', multiple: true, describe: 'task ids that must complete first' },
    parent: { type: 'string', placeholder: 'task_id', describe: 'parent task, for grouping' },
    priority: { type: 'number', default: 0, describe: 'higher sorts first in --ready' },
    'max-attempts': { type: 'number', default: 3, describe: 'circuit-breaker threshold' },
  },
  async run(ctx) {
    const run = resolveRun(ctx, { create: true });
    const store = ctx.store(true);
    const spec = readSpec(ctx.flags);
    if (!spec) throw usage('--spec or --spec-file is required');

    const deps = csv(ctx.flags.deps).map((d) => resolveTaskId(store, run.run_id, d));
    const task = createTask(store, run, {
      spec,
      title: ctx.flags.title,
      deps,
      parentId: ctx.flags.parent ? resolveTaskId(store, run.run_id, ctx.flags.parent) : null,
      priority: ctx.flags.priority,
      maxAttempts: ctx.flags['max-attempts'],
    });

    say(ctx, `${c.green('task created')}  ${c.bold(task.task_id)}  ${paintState(task.state)}`);
    say(ctx, kv([
      ['title', task.title],
      ['run', run.run_id],
      ['deps', deps.join(', ') || null],
    ]));
    if (task.state === 'ready') {
      say(ctx, c.dim(`\n  next: cbds dispatch start --task ${task.task_id} --agent claude`));
    } else {
      say(ctx, c.dim(`\n  waiting on ${deps.length} dependency(ies)`));
    }
    return emit(ctx, task);
  },
};

export const list = {
  summary: 'List tasks',
  usage: 'cbds task list [--state <s>] [--ready] [--brief]',
  flags: {
    state: { type: 'string', describe: `filter: ${TASK_STATES.join('|')}` },
    ready: { type: 'boolean', describe: 'only tasks dispatchable right now' },
    brief: { type: 'boolean', describe: 'omit the spec from --json output' },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    let tasks = listTasks(store, run.run_id).map((t) => reconcileTaskReadiness(store, t));

    if (ctx.flags.state) {
      oneOf(ctx.flags.state, TASK_STATES, 'state');
      tasks = tasks.filter((t) => t.state === ctx.flags.state);
    }
    if (ctx.flags.ready) {
      tasks = tasks.filter((t) => (t.state === 'ready' || t.state === 'failed') && depsSatisfied(store, t) && t.attempts < t.max_attempts);
    }
    tasks.sort((a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at));

    say(ctx, table(tasks, [
      { header: 'TASK', get: (t) => c.bold(t.task_id) },
      { header: 'STATE', get: (t) => paintState(t.state) },
      { header: 'TRY', get: (t) => `${t.attempts}/${t.max_attempts}` },
      { header: 'PANE', get: (t) => {
        if (!t.live_dispatch_id) return c.dim('—');
        const d = listDispatches(store, run.run_id).find((x) => x.dispatch_id === t.live_dispatch_id);
        return d?.target?.pane_id ?? c.dim('—');
      } },
      { header: 'AGE', get: (t) => relTime(t.created_at) },
      { header: 'TITLE', get: (t) => truncate(t.title, 44) },
    ]));

    const out = ctx.flags.brief
      ? tasks.map(({ spec, ...rest }) => ({ ...rest, spec_truncated: truncate(spec, 160) }))
      : tasks;
    return emit(ctx, { run_id: run.run_id, count: tasks.length, tasks: out });
  },
};

export const show = {
  summary: 'Show one task with its dispatch history',
  usage: 'cbds task show <task_id>',
  flags: {},
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const id = resolveTaskId(store, run.run_id, requireFlag({ id: ctx.positional[0] }, 'id', 'cbds task show <task_id>'));
    const task = reconcileTaskReadiness(store, loadTask(store, run.run_id, id));
    const dispatches = listDispatches(store, run.run_id).filter((d) => d.task_id === task.task_id);

    say(ctx, `${c.bold(task.task_id)}  ${paintState(task.state)}  ${c.dim(`attempt ${task.attempts}/${task.max_attempts}`)}`);
    say(ctx, kv([
      ['title', task.title],
      ['run', task.run_id],
      ['deps', task.deps.join(', ') || null],
      ['live dispatch', task.live_dispatch_id],
      ['created', relTime(task.created_at)],
      ['updated', relTime(task.updated_at)],
    ]));
    say(ctx, `\n${c.dim('  spec')}`);
    say(ctx, task.spec.split('\n').map((l) => `    ${l}`).join('\n'));
    if (dispatches.length) {
      say(ctx, `\n${c.dim('  dispatches')}`);
      say(ctx, table(dispatches, [
        { header: 'DISPATCH', get: (d) => d.dispatch_id },
        { header: 'STATE', get: (d) => paintState(d.state) },
        { header: 'AUTH', get: (d) => (d.authority ? c.green('yes') : c.dim('no')) },
        { header: 'PANE', get: (d) => d.target.pane_id ?? c.dim('—') },
        { header: 'OUTCOME', get: (d) => (d.outcome ? paintState(d.outcome) : c.dim('—')) },
        { header: 'STARTED', get: (d) => relTime(d.started_at) },
      ]));
    }
    if (task.result) {
      say(ctx, `\n${c.dim('  result')}`);
      say(ctx, `    ${paintState(task.result.outcome)}  ${task.result.subject ?? ''}`);
      if (task.result.body) say(ctx, task.result.body.split('\n').map((l) => `    ${l}`).join('\n'));
    }
    return emit(ctx, { ...task, dispatches });
  },
};

export const update = {
  summary: 'Update a task (state changes are validated against the lifecycle)',
  usage: 'cbds task update <task_id> [--state <s>] [--spec <t>] ...',
  flags: {
    state: { type: 'string', describe: `target state: ${TASK_STATES.join('|')}` },
    spec: { type: 'string', describe: 'replace the spec' },
    title: { type: 'string', describe: 'replace the title' },
    deps: { type: 'string', multiple: true, describe: 'replace dependencies' },
    priority: { type: 'number', describe: 'replace priority' },
    'max-attempts': { type: 'number', describe: 'raise the circuit-breaker threshold' },
    result: { type: 'string', placeholder: 'json', describe: 'attach a result object' },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const id = resolveTaskId(store, run.run_id, requireFlag({ id: ctx.positional[0] }, 'id', 'cbds task update <task_id>'));
    const task = loadTask(store, run.run_id, id);
    const before = task.state;

    if (ctx.flags.state) {
      const target = oneOf(ctx.flags.state, TASK_STATES, 'state');
      // `completed` is reachable only through an accepted report. Allowing a manual
      // flip would let task state and report state disagree, which is the exact
      // ambiguity cbds exists to remove.
      if (target === 'completed') {
        throw conflict('manual_completion_forbidden',
          'a task can only be completed by an accepted report',
          'the worker must run `cbds done --outcome succeeded`');
      }
      assertTaskTransition(task, target);
      task.state = target;
    }
    if (ctx.flags.spec) task.spec = ctx.flags.spec;
    if (ctx.flags.title) task.title = ctx.flags.title;
    if (ctx.flags.deps !== undefined) {
      task.deps = csv(ctx.flags.deps).map((d) => resolveTaskId(store, run.run_id, d));
    }
    if (ctx.flags.priority !== undefined) task.priority = ctx.flags.priority;
    if (ctx.flags['max-attempts'] !== undefined) task.max_attempts = ctx.flags['max-attempts'];
    if (ctx.flags.result) {
      try { task.result = JSON.parse(ctx.flags.result); }
      catch { throw usage('--result must be valid JSON'); }
    }

    saveTask(store, task, { event: 'task.updated', from: before, to: task.state });
    reconcileTaskReadiness(store, task);
    say(ctx, `${c.green('task updated')}  ${c.bold(task.task_id)}  ${paintState(before)} ${c.dim('->')} ${paintState(task.state)}`);
    return emit(ctx, task);
  },
};

export const cancel = {
  summary: 'Cancel a task and revoke authority from its live dispatch',
  usage: 'cbds task cancel <task_id> [--reason <text>]',
  flags: { reason: { type: 'string', describe: 'why it was cancelled' } },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const id = resolveTaskId(store, run.run_id, requireFlag({ id: ctx.positional[0] }, 'id', 'cbds task cancel <task_id>'));
    const task = loadTask(store, run.run_id, id);
    assertTaskTransition(task, 'cancelled');

    if (task.live_dispatch_id) {
      const dispatch = loadDispatch(store, run.run_id, task.live_dispatch_id);
      supersedeDispatch(store, dispatch, ctx.flags.reason ?? 'task cancelled');
    }
    const before = task.state;
    task.state = 'cancelled';
    task.live_dispatch_id = null;
    task.result = { outcome: 'cancelled', reason: ctx.flags.reason ?? null, at: new Date().toISOString() };
    saveTask(store, task, { event: 'task.cancelled', from: before, reason: ctx.flags.reason ?? null });

    say(ctx, `${c.yellow('task cancelled')}  ${c.bold(task.task_id)}`);
    say(ctx, c.dim('  its worker pane is left running; close it with `cbds release` or `herdr pane close`'));
    return emit(ctx, task);
  },
};
