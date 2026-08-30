import { requireFlag } from '../core/args.mjs';
import { notFound } from '../core/errors.mjs';
import { emit, say, table, kv, c, paintState, relTime, truncate } from '../core/output.mjs';
import { scanInbox, scanRejected, readCursor, markAcked } from '../core/inbox.mjs';
import { resolveRun, resolveTaskId } from '../core/context.mjs';

const findReport = (R, id) =>
  [...scanInbox(R), ...scanRejected(R)]
    .find((r) => r.report_id === id || r.report_id.endsWith(id));

export const list = {
  summary: 'List reports in the run inbox',
  usage: 'cbds report list [--task <id>] [--rejected] [--unacked]',
  flags: {
    task: { type: 'string', placeholder: 'task_id', describe: 'filter by task' },
    rejected: { type: 'boolean', describe: 'show rejected reports instead of accepted ones' },
    all: { type: 'boolean', describe: 'show accepted and rejected together' },
    unacked: { type: 'boolean', describe: 'only reports newer than the cursor' },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const R = store.run(run.run_id);
    const cursor = readCursor(R);

    let reports = ctx.flags.all
      ? [...scanInbox(R), ...scanRejected(R)]
      : (ctx.flags.rejected ? scanRejected(R) : scanInbox(R));

    if (ctx.flags.task) {
      const id = resolveTaskId(store, run.run_id, ctx.flags.task);
      reports = reports.filter((r) => r.task_id === id);
    }
    if (ctx.flags.unacked) reports = reports.filter((r) => r.seq > cursor.acked_seq);
    reports.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

    say(ctx, table(reports, [
      { header: 'SEQ', get: (r) => String(r.seq) },
      { header: 'REPORT', get: (r) => c.bold(r.report_id) },
      { header: 'OUTCOME', get: (r) => paintState(r.outcome) },
      { header: 'OK', get: (r) => (r.acceptance?.accepted ? c.green('yes') : c.red(r.acceptance?.reason ?? 'no')) },
      { header: 'ACK', get: (r) => (r.seq <= cursor.acked_seq ? c.dim('acked') : c.yellow('new')) },
      { header: 'TASK', get: (r) => r.task_id },
      { header: 'WHEN', get: (r) => relTime(r.reported_at) },
      { header: 'SUBJECT', get: (r) => truncate(r.subject ?? '', 36) },
    ]));
    return emit(ctx, {
      run_id: run.run_id, acked_seq: cursor.acked_seq, count: reports.length,
      reports: reports.map(({ _file, ...r }) => r),
    });
  },
};

export const show = {
  summary: 'Show one report in full',
  usage: 'cbds report show <report_id>',
  flags: {},
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const R = store.run(run.run_id);
    const id = requireFlag({ id: ctx.positional[0] }, 'id', 'cbds report show <report_id>');
    const report = findReport(R, id);
    if (!report) throw notFound('report', id);

    const ok = report.acceptance?.accepted;
    say(ctx, `${c.bold(report.report_id)}  ${paintState(report.outcome)}  ${ok ? c.green('accepted') : c.red(`rejected: ${report.acceptance?.reason}`)}`);
    say(ctx, kv([
      ['seq', String(report.seq)],
      ['task', report.task_id],
      ['dispatch', report.dispatch_id],
      ['subject', report.subject],
      ['reported', `${relTime(report.reported_at)}  ${c.dim(report.reported_at)}`],
      ['from pane', report.reported_from?.pane_id],
      ['files', report.files_modified?.join(', ') || null],
      ['artifacts', report.artifacts?.join(', ') || null],
      ['question', report.question],
      ['next steps', report.next_steps],
      ['acked', report.acked_at ? relTime(report.acked_at) : null],
    ]));
    if (report.body) {
      say(ctx, `\n${c.dim('  body')}`);
      say(ctx, report.body.split('\n').map((l) => `    ${l}`).join('\n'));
    }
    const { _file, ...clean } = report;
    return emit(ctx, clean);
  },
};

export const ack = {
  summary: 'Acknowledge a report, advancing the run cursor',
  usage: 'cbds report ack <report_id>',
  flags: {},
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const R = store.run(run.run_id);
    const id = requireFlag({ id: ctx.positional[0] }, 'id', 'cbds report ack <report_id>');
    const report = findReport(R, id);
    if (!report) throw notFound('report', id);
    const acked = markAcked(R, report);
    say(ctx, `${c.green('acked')}  ${c.bold(acked.report_id)}  ${c.dim(`cursor -> seq ${acked.seq}`)}`);
    return emit(ctx, acked);
  },
};
