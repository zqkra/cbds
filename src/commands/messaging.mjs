import path from 'node:path';
import { csv, requireFlag } from '../core/args.mjs';
import { CbdsError, EXIT, usage, notFound } from '../core/errors.mjs';
import { emit, say, c, paintState, relTime, duration, truncate } from '../core/output.mjs';
import { loadTask, loadDispatch, addHint } from '../core/model.mjs';
import {
  buildMessage, writeMessage, scanInbox, scanOutbox, waitForReport, messageType,
} from '../core/inbox.mjs';
import { resolveRun, resolveDispatchId } from '../core/context.mjs';
import { nowIso, readJson, writeJsonAtomic, ensureDir } from '../core/store.mjs';

/**
 * Resolve the caller's own dispatch identity from the pane environment.
 *
 * Every worker-side verb goes through this, and it enforces the same rule as
 * `cbds done`: a worker whose dispatch no longer holds authority must not keep
 * emitting lifecycle traffic. Stale preambles are the failure mode this prevents.
 */
const selfDispatch = (ctx, { requireAuthority = true } = {}) => {
  const runId = ctx.flags.run ?? process.env.CBDS_RUN_ID;
  const taskId = ctx.flags['task-id'] ?? process.env.CBDS_TASK_ID;
  const dispatchId = ctx.flags['dispatch-id'] ?? process.env.CBDS_DISPATCH_ID;

  if (!runId || !dispatchId) {
    throw usage('no dispatch identity in this pane',
      'these come from the environment inside a cbds worker pane. Run `cbds whoami`; if it says you are not a live worker, your preamble is stale — do not send lifecycle messages.');
  }
  const store = ctx.store();
  const dispatch = loadDispatch(store, runId, dispatchId);
  const task = loadTask(store, runId, dispatch.task_id);

  if (requireAuthority && (!dispatch.authority || dispatch.state === 'settled')) {
    throw new CbdsError('stale_dispatch',
      `dispatch ${dispatchId} no longer holds authority (state: ${dispatch.state})`, {
        exit: EXIT.STALE_DISPATCH,
        hint: 'this attempt was superseded or already settled. Do not report; tell the user.',
      });
  }
  if (taskId && taskId !== dispatch.task_id) {
    throw new CbdsError('dispatch_task_mismatch',
      `dispatch ${dispatchId} belongs to task ${dispatch.task_id}, not ${taskId}`, {
        exit: EXIT.STALE_DISPATCH,
      });
  }
  return { store, runId, dispatch, task, R: store.run(runId) };
};

/** Per-dispatch read cursor for worker-bound mail, so nothing is delivered twice. */
const readDispatchCursor = (R, dispatchId) =>
  readJson(R.dispatchCursor(dispatchId), { optional: true }) ?? { acked_seq: 0 };

const advanceDispatchCursor = (R, dispatchId, seq) => {
  const file = R.dispatchCursor(dispatchId);
  const cursor = readDispatchCursor(R, dispatchId);
  if (seq > cursor.acked_seq) {
    ensureDir(path.dirname(file));
    writeJsonAtomic(file, { acked_seq: seq });
  }
};

/* ------------------------------------------------------------- heartbeat -- */

export const heartbeat = {
  summary: 'Signal that you are alive and what phase you are in (worker)',
  usage: 'cbds heartbeat --phase investigating|implementing|reviewing|waiting',
  flags: {
    phase: { type: 'string', describe: 'short phase label' },
    note: { type: 'string', describe: 'optional one-line detail' },
    'task-id': { type: 'string', hidden: true },
    'dispatch-id': { type: 'string', hidden: true },
  },
  async run(ctx) {
    const { store, runId, dispatch, R } = selfDispatch(ctx);
    const phase = ctx.flags.phase ?? 'working';

    // A heartbeat is liveness, not progress-as-truth. It updates the dispatch's
    // hint trail so the board and a timed-out wait can show it, and it does not
    // wake a coordinator that is waiting for a real result.
    const message = buildMessage({
      type: 'heartbeat', runId, taskId: dispatch.task_id, dispatchId: dispatch.dispatch_id,
      subject: 'alive', body: ctx.flags.note ?? null, phase,
    });
    const { report: stored } = writeMessage(R, message);

    dispatch.last_heartbeat_at = nowIso();
    dispatch.phase = phase;
    addHint(store, dispatch, 'heartbeat', phase);

    say(ctx, `${c.dim('heartbeat')} ${paintState('dispatched')} phase=${c.bold(phase)}`);
    return emit(ctx, { message: stored, dispatch_id: dispatch.dispatch_id, phase });
  },
};

/* ------------------------------------------------------------ escalation -- */

export const escalate = {
  summary: 'Raise a blocker to the coordinator without ending your task (worker)',
  usage: 'cbds escalate --subject <text> --body <text>',
  flags: {
    subject: { type: 'string', describe: 'one line: what is blocking you' },
    body: { type: 'string', describe: 'the detail the coordinator needs' },
    'task-id': { type: 'string', hidden: true },
    'dispatch-id': { type: 'string', hidden: true },
  },
  async run(ctx) {
    const { runId, dispatch, R } = selfDispatch(ctx);
    const subject = requireFlag(ctx.flags, 'subject', 'e.g. --subject "Blocked: missing credentials"');

    const message = buildMessage({
      type: 'escalation', runId, taskId: dispatch.task_id, dispatchId: dispatch.dispatch_id,
      subject, body: ctx.flags.body ?? null,
    });
    const { report: stored } = writeMessage(R, message);

    say(ctx, `${c.yellow('escalated')}  ${c.bold(subject)}`);
    say(ctx, c.dim('  the coordinator has been woken. Your task is NOT settled — you still owe a report.'));
    return emit(ctx, { message: stored });
  },
};

/* ------------------------------------------------------------------ ask -- */

export const ask = {
  summary: 'Ask the coordinator a question and block until it answers (worker)',
  usage: 'cbds ask --question <text> [--options a,b] --timeout <ms>',
  flags: {
    question: { type: 'string', describe: 'what you need to know' },
    options: { type: 'string', placeholder: 'csv', describe: 'suggested answers' },
    timeout: { type: 'number', default: 600000, placeholder: 'ms', describe: 'how long to block' },
    resume: { type: 'string', placeholder: 'message_id', describe: 'wait again on an already-asked question' },
    poll: { type: 'number', default: 2000, placeholder: 'ms', describe: 'safety poll interval' },
    'task-id': { type: 'string', hidden: true },
    'dispatch-id': { type: 'string', hidden: true },
  },
  async run(ctx) {
    const { runId, dispatch, R } = selfDispatch(ctx);

    let questionId = ctx.flags.resume ?? null;
    if (!questionId) {
      const text = requireFlag(ctx.flags, 'question', 'e.g. --question "shared component or page-only?"');
      const message = buildMessage({
        type: 'question', runId, taskId: dispatch.task_id, dispatchId: dispatch.dispatch_id,
        subject: truncate(text, 60), question: text, options: csv(ctx.flags.options),
      });
      const { report: stored } = writeMessage(R, message);
      questionId = stored.report_id;
      say(ctx, `${c.cyan('asked')}  ${c.bold(questionId)}  ${c.dim('blocking for an answer…')}`);
    } else {
      say(ctx, `${c.cyan('resuming')} question ${c.bold(questionId)}`);
    }

    const matches = (m) => messageType(m) === 'reply'
      && m.in_reply_to === questionId
      && m.dispatch_id === dispatch.dispatch_id;

    const result = await waitForReport({ ...R, inbox: R.outbox }, {
      matches, timeoutMs: ctx.flags.timeout, pollMs: ctx.flags.poll,
    });

    if (result.status !== 'found') {
      // The question stays durably pending. Resuming by id is what prevents a
      // timeout from creating a second, duplicate question thread.
      const err = new CbdsError('ask_timeout',
        `no answer within ${duration(ctx.flags.timeout)}`, {
          exit: EXIT.TIMEOUT,
          details: { question_id: questionId },
          hint: `the question is still pending — wait again with \`cbds ask --resume ${questionId} --timeout <ms>\`, never by asking again`,
        });
      if (ctx.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, command: ctx.commandName, error: err.toJSON(), data: { question_id: questionId } }, null, 2)}\n`);
        process.exitCode = EXIT.TIMEOUT;
        return null;
      }
      throw err;
    }

    const answer = result.reports[0];
    // An answered question must not reappear as unread mail on the next `check`.
    advanceDispatchCursor(R, dispatch.dispatch_id, answer.seq);

    say(ctx, `${c.green('answer')}  ${answer.body ?? answer.subject ?? ''}`);
    return emit(ctx, { question_id: questionId, answer });
  },
};

/* ---------------------------------------------------------------- check -- */

export const check = {
  summary: 'Read messages the coordinator sent you (worker)',
  usage: 'cbds check [--wait --timeout <ms>]',
  flags: {
    wait: { type: 'boolean', describe: 'block until something arrives' },
    timeout: { type: 'number', default: 300000, placeholder: 'ms', describe: 'used with --wait' },
    all: { type: 'boolean', describe: 'include messages already acknowledged' },
    poll: { type: 'number', default: 2000, placeholder: 'ms', hidden: true },
    'task-id': { type: 'string', hidden: true },
    'dispatch-id': { type: 'string', hidden: true },
  },
  async run(ctx) {
    const { runId, dispatch, R } = selfDispatch(ctx, { requireAuthority: false });
    const cursor = readDispatchCursor(R, dispatch.dispatch_id);

    const mine = (m) => m.dispatch_id === dispatch.dispatch_id
      && (ctx.flags.all || m.seq > cursor.acked_seq);

    let messages = scanOutbox(R).filter(mine);

    if (!messages.length && ctx.flags.wait) {
      const result = await waitForReport({ ...R, inbox: R.outbox }, {
        matches: mine, timeoutMs: ctx.flags.timeout, pollMs: ctx.flags.poll,
      });
      messages = result.reports ?? [];
      if (result.status !== 'found') {
        say(ctx, c.dim(`no messages within ${duration(ctx.flags.timeout)}`));
        return emit(ctx, { count: 0, messages: [] });
      }
    }

    if (messages.length) {
      advanceDispatchCursor(R, dispatch.dispatch_id, Math.max(...messages.map((m) => m.seq)));
    }

    say(ctx, messages.length ? '' : c.dim('  no new messages'));
    for (const m of messages) {
      say(ctx, `  ${c.cyan(messageType(m))}  ${c.bold(m.subject ?? '')}  ${c.dim(relTime(m.reported_at))}`);
      if (m.body) say(ctx, m.body.split('\n').map((l) => `    ${l}`).join('\n'));
    }
    return emit(ctx, { count: messages.length, messages: messages.map(({ _file, ...m }) => m) });
  },
};

/* ---------------------------------------------------------------- reply -- */

export const reply = {
  summary: 'Answer a worker’s question (coordinator)',
  usage: 'cbds reply --id <message_id> --body <answer>',
  flags: {
    id: { type: 'string', placeholder: 'message_id', describe: 'the question to answer' },
    body: { type: 'string', describe: 'the answer' },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const R = store.run(run.run_id);
    const id = ctx.flags.id ?? ctx.positional[0];
    if (!id) throw usage('--id <message_id> is required', 'take it from `cbds wait` or `cbds report list`');
    const body = requireFlag(ctx.flags, 'body', 'the answer the worker is blocked on');

    const question = scanInbox(R).find((m) => messageType(m) === 'question'
      && (m.report_id === id || m.report_id.endsWith(id)));
    if (!question) throw notFound('question', id);

    const message = buildMessage({
      type: 'reply', to: `dispatch:${question.dispatch_id}`,
      runId: run.run_id, taskId: question.task_id, dispatchId: question.dispatch_id,
      subject: `re: ${truncate(question.question ?? '', 50)}`,
      body, inReplyTo: question.report_id,
    });
    const { report: stored } = writeMessage(R, message);

    say(ctx, `${c.green('replied')} to ${c.bold(question.report_id)}  ${c.dim('the worker is unblocked')}`);
    return emit(ctx, { reply: stored, question });
  },
};

/* ----------------------------------------------------------------- send -- */

export const send = {
  summary: 'Send follow-up guidance to a live worker (coordinator)',
  usage: 'cbds send --to <dispatch_id> --subject <text> --body <text>',
  flags: {
    to: { type: 'string', placeholder: 'dispatch_id', describe: 'the worker to reach' },
    subject: { type: 'string', describe: 'one line' },
    body: { type: 'string', describe: 'the guidance' },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const R = store.run(run.run_id);
    const target = resolveDispatchId(store, run.run_id, requireFlag(ctx.flags, 'to', 'e.g. --to dsp_…'));
    const dispatch = loadDispatch(store, run.run_id, target);

    // Structured mail, not prompt injection: the worker receives it on its next
    // `cbds check`, so it can never interrupt or corrupt an in-flight turn.
    const message = buildMessage({
      type: 'follow_up', to: `dispatch:${target}`,
      runId: run.run_id, taskId: dispatch.task_id, dispatchId: target,
      subject: requireFlag(ctx.flags, 'subject', 'one line summarising the guidance'),
      body: ctx.flags.body ?? null,
    });
    const { report: stored } = writeMessage(R, message);

    say(ctx, `${c.green('sent')} to ${c.bold(target)}  ${c.dim('(arrives on the worker’s next `cbds check`)')}`);
    return emit(ctx, { message: stored });
  },
};
