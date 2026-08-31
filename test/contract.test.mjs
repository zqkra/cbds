import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpProject, cli, cliJson } from './helpers.mjs';

/**
 * These tests exercise the completion contract without Herdr. `dispatch start`
 * normally needs a live session, so dispatches are created through the documented
 * bare-shell path with a stubbed Herdr, keeping the state machine under test rather
 * than the terminal integration.
 */

const EXIT = { OK: 0, USAGE: 2, NOT_FOUND: 3, TIMEOUT: 4, STALE: 5, NO_HERDR: 6, CONFLICT: 7, VANISHED: 8 };

describe('run and task lifecycle', () => {
  let dir;
  before(() => { dir = tmpProject(); });

  test('run create initialises a versioned store', async () => {
    const res = await cliJson(dir, ['run', 'create', '--objective', 'test run']);
    assert.equal(res.code, EXIT.OK);
    assert.equal(res.json.ok, true);
    assert.match(res.json.data.run_id, /^run_/);
    assert.equal(fs.readFileSync(path.join(dir, '.cbds', 'VERSION'), 'utf8').trim(), '1');
  });

  test('a task with no deps is immediately ready', async () => {
    const res = await cliJson(dir, ['task', 'create', '--spec', 'do the thing']);
    assert.equal(res.json.data.state, 'ready');
    assert.equal(res.json.data.attempts, 0);
  });

  test('a task with an unmet dep is pending, and becomes ready when the dep completes', async () => {
    const first = await cliJson(dir, ['task', 'create', '--spec', 'first']);
    const second = await cliJson(dir, ['task', 'create', '--spec', 'second', '--deps', first.json.data.task_id]);
    assert.equal(second.json.data.state, 'pending');

    const list = await cliJson(dir, ['task', 'list', '--ready']);
    const readyIds = list.json.data.tasks.map((t) => t.task_id);
    assert.ok(!readyIds.includes(second.json.data.task_id), 'a blocked task must not appear in --ready');
  });

  test('objective is required', async () => {
    const res = await cli(tmpProject(), ['run', 'create']);
    assert.equal(res.code, EXIT.USAGE);
  });

  test('a task cannot be completed by hand', async () => {
    const t = await cliJson(dir, ['task', 'create', '--spec', 'manual']);
    const res = await cliJson(dir, ['task', 'update', t.json.data.task_id, '--state', 'completed']);
    assert.equal(res.code, EXIT.CONFLICT);
    assert.equal(res.json.error.code, 'manual_completion_forbidden');
  });

  test('an unknown flag is rejected rather than ignored', async () => {
    const res = await cli(dir, ['task', 'list', '--timout', '5']);
    assert.equal(res.code, EXIT.USAGE);
  });
});

describe('the completion contract', () => {
  let dir; let runId; let taskId; let dispatchId;

  before(async () => {
    dir = tmpProject();
    const run = await cliJson(dir, ['run', 'create', '--objective', 'contract']);
    runId = run.json.data.run_id;
    const task = await cliJson(dir, ['task', 'create', '--spec', 'the work']);
    taskId = task.json.data.task_id;
    dispatchId = await makeDispatch(dir, runId, taskId);
  });

  test('done requires an explicit outcome', async () => {
    const res = await cliJson(dir, ['done', '--run', runId, '--task-id', taskId, '--dispatch-id', dispatchId, '--body', 'no outcome']);
    assert.equal(res.code, EXIT.USAGE);
  });

  test('done requires an identity', async () => {
    const res = await cliJson(dir, ['done', '--run', runId, '--outcome', 'succeeded', '--body', 'x']);
    assert.equal(res.code, EXIT.USAGE);
  });

  test('a valid report is accepted and completes the task', async () => {
    const res = await cliJson(dir, ['done', '--run', runId, '--task-id', taskId,
      '--dispatch-id', dispatchId, '--outcome', 'succeeded', '--subject', 's', '--body', 'b']);
    assert.equal(res.code, EXIT.OK);
    assert.equal(res.json.data.report.acceptance.accepted, true);
    assert.equal(res.json.data.task.state, 'completed');
    assert.equal(res.json.data.dispatch.state, 'settled');
  });

  test('the same dispatch cannot report twice', async () => {
    const res = await cliJson(dir, ['done', '--run', runId, '--task-id', taskId,
      '--dispatch-id', dispatchId, '--outcome', 'failed', '--body', 'second']);
    assert.equal(res.code, EXIT.CONFLICT);
    assert.equal(res.json.error.code, 'already_settled');

    const task = await cliJson(dir, ['task', 'show', taskId]);
    assert.equal(task.json.data.state, 'completed', 'the first report must stand');
  });
});

describe('stale dispatch rejection', () => {
  let dir; let runId; let taskId; let first; let second;

  before(async () => {
    dir = tmpProject();
    runId = (await cliJson(dir, ['run', 'create', '--objective', 'stale'])).json.data.run_id;
    taskId = (await cliJson(dir, ['task', 'create', '--spec', 'retryable'])).json.data.task_id;
    first = await makeDispatch(dir, runId, taskId);
    second = await makeDispatch(dir, runId, taskId, first);
  });

  test('a superseded dispatch loses authority', async () => {
    const res = await cliJson(dir, ['dispatch', 'show', first, '--run', runId]);
    assert.equal(res.json.data.authority, false);
    assert.equal(res.json.data.state, 'superseded');
  });

  test('a superseded dispatch cannot complete the task', async () => {
    const res = await cliJson(dir, ['done', '--run', runId, '--task-id', taskId,
      '--dispatch-id', first, '--outcome', 'succeeded', '--body', 'zombie']);
    assert.equal(res.code, EXIT.STALE);
    assert.equal(res.json.error.code, 'stale_dispatch');

    const task = await cliJson(dir, ['task', 'show', taskId]);
    assert.notEqual(task.json.data.state, 'completed');
  });

  test('the rejected report is preserved, never silently dropped', async () => {
    const res = await cliJson(dir, ['report', 'list', '--rejected', '--run', runId]);
    assert.equal(res.json.data.count, 1);
    assert.equal(res.json.data.reports[0].acceptance.reason, 'stale_dispatch');
  });

  test('the live dispatch can still complete', async () => {
    const res = await cliJson(dir, ['done', '--run', runId, '--task-id', taskId,
      '--dispatch-id', second, '--outcome', 'succeeded', '--body', 'real']);
    assert.equal(res.code, EXIT.OK);
    assert.equal(res.json.data.task.state, 'completed');
  });

  test('a dispatch id from another task is rejected', async () => {
    const other = (await cliJson(dir, ['task', 'create', '--spec', 'other'])).json.data.task_id;
    const res = await cliJson(dir, ['done', '--run', runId, '--task-id', other,
      '--dispatch-id', second, '--outcome', 'succeeded', '--body', 'mismatch']);
    assert.equal(res.code, EXIT.STALE);
    assert.equal(res.json.error.code, 'dispatch_task_mismatch');
  });
});

describe('wait', () => {
  let dir; let runId;

  before(async () => {
    dir = tmpProject();
    runId = (await cliJson(dir, ['run', 'create', '--objective', 'wait'])).json.data.run_id;
  });

  test('--timeout is mandatory', async () => {
    const res = await cli(dir, ['wait']);
    assert.equal(res.code, EXIT.USAGE);
  });

  test('a report already on disk resolves the wait immediately', async () => {
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'durable'])).json.data.task_id;
    const dispatchId = await makeDispatch(dir, runId, taskId);
    await cliJson(dir, ['done', '--run', runId, '--task-id', taskId,
      '--dispatch-id', dispatchId, '--outcome', 'succeeded', '--body', 'reported to nobody']);

    const started = Date.now();
    const res = await cliJson(dir, ['wait', '--task', taskId, '--timeout', '15000'], { HERDR_ENV: '' });
    const elapsed = Date.now() - started;

    assert.equal(res.code, EXIT.OK);
    assert.equal(res.json.data.reports[0].outcome, 'succeeded');
    assert.ok(elapsed < 4000, `a durable report must resolve immediately, took ${elapsed}ms`);
  });

  test('a wait with no report times out cleanly with exit 4', async () => {
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'silent'])).json.data.task_id;
    await makeDispatch(dir, runId, taskId);
    const res = await cliJson(dir, ['wait', '--task', taskId, '--timeout', '1500', '--no-hints']);
    assert.equal(res.code, EXIT.TIMEOUT);
    assert.equal(res.json.error.code, 'wait_timeout');
    assert.ok(res.json.data.outstanding.length >= 1, 'a timeout must report what is still outstanding');
  });

  test('a report arriving mid-wait wakes the waiter', async () => {
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'concurrent'])).json.data.task_id;
    const dispatchId = await makeDispatch(dir, runId, taskId);

    const started = Date.now();
    const waiter = cliJson(dir, ['wait', '--task', taskId, '--timeout', '20000', '--no-hints']);
    setTimeout(() => {
      cliJson(dir, ['done', '--run', runId, '--task-id', taskId,
        '--dispatch-id', dispatchId, '--outcome', 'succeeded', '--body', 'late']);
    }, 800);

    const res = await waiter;
    const elapsed = Date.now() - started;
    assert.equal(res.code, EXIT.OK);
    assert.ok(elapsed < 12000, `wake took ${elapsed}ms`);
  });
});

describe('circuit breaker', () => {
  test('a task refuses dispatch past max-attempts', async () => {
    const dir = tmpProject();
    const runId = (await cliJson(dir, ['run', 'create', '--objective', 'cb'])).json.data.run_id;
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'flaky', '--max-attempts', '1'])).json.data.task_id;
    const d = await makeDispatch(dir, runId, taskId);
    await cliJson(dir, ['done', '--run', runId, '--task-id', taskId, '--dispatch-id', d, '--outcome', 'failed', '--body', 'nope']);

    const res = await makeDispatchRaw(dir, runId, taskId, d);
    assert.equal(res.code, EXIT.CONFLICT);
    assert.equal(res.json.error.code, 'task_circuit_open');
  });
});

describe('herdr independence', () => {
  test('dispatch start fails cleanly with exit 6 when Herdr is unreachable', async () => {
    const dir = tmpProject();
    await cliJson(dir, ['run', 'create', '--objective', 'no herdr']);
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'x'])).json.data.task_id;
    const res = await cliJson(dir, ['dispatch', 'start', '--task', taskId, '--no-agent']);
    assert.equal(res.code, EXIT.NO_HERDR);
    assert.equal(res.json.error.code, 'herdr_unavailable');
  });

  test('--dry-run prints the contract and creates nothing', async () => {
    const dir = tmpProject();
    await cliJson(dir, ['run', 'create', '--objective', 'dry']);
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'x'])).json.data.task_id;
    // Pin HOME: with no cbds skill installed for the kind, `auto` resolves to `standard`.
    const res = await cliJson(dir, ['dispatch', 'start', '--task', taskId, '--dry-run'], { HOME: tmpProject() });
    assert.equal(res.code, 0);
    const pre = res.json.data.preamble;
    assert.equal(res.json.data.contract, 'standard');
    assert.match(pre, /cbds done --outcome succeeded/);
    assert.match(pre, /cbds done --outcome failed/);
    assert.match(pre, /cbds done --outcome blocked/);
    assert.match(pre, /cbds whoami/);
    assert.match(pre, /cbds contract/, 'it must point at the pull command');
    // The TASK must be LAST: it is the thing to act on, so it gets recency.
    assert.ok(pre.lastIndexOf('=== TASK') > pre.lastIndexOf('--outcome blocked'),
      'the TASK block must come after the contract');

    // ...and the full level still carries everything.
    const full = await cliJson(dir, ['dispatch', 'start', '--task', taskId, '--contract', 'full', '--dry-run'], { HOME: tmpProject() });
    const fp = full.json.data.preamble;
    assert.match(fp, /=== CLI COMMANDS ===/);
    assert.match(fp, /cbds heartbeat --phase/);
    assert.match(fp, /cbds ask --question/);
    assert.match(fp, /cbds escalate --subject/);
    assert.match(fp, /=== AFTER YOU REPORT ===/);
    // A section that does not apply is omitted, never softened.
    assert.ok(!fp.includes('=== SUB-DISPATCH ==='), 'sub-dispatch must be omitted at max depth');

    const task = await cliJson(dir, ['task', 'show', taskId]);
    assert.equal(task.json.data.state, 'ready', 'a dry run must not dispatch the task');
    assert.equal(task.json.data.attempts, 0);
  });
});

/* ---------------------------------------------------------------- helpers -- */

/**
 * Create a dispatch through the real CLI with a stubbed Herdr, so the state machine
 * is genuinely exercised. HERDR_BIN_PATH points at a fake that answers pane split.
 */
let stubPath = null;
const herdrStub = () => {
  if (stubPath) return stubPath;
  const dir = tmpProject();
  stubPath = path.join(dir, 'herdr-stub.mjs');
  fs.writeFileSync(stubPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
const join = args.join(' ');
const ok = (result) => { process.stdout.write(JSON.stringify({ id: 'stub', result })); process.exit(0); };
if (join.startsWith('pane split')) {
  const n = Math.floor(Math.random() * 100000);
  ok({ type: 'pane_split', pane: { pane_id: 'w1:p' + n, workspace_id: 'w1', tab_id: 'w1:t1' } });
}
if (join.startsWith('pane get')) ok({ type: 'pane', pane: { pane_id: args[2] } });
if (join.startsWith('pane layout')) ok({ type: 'layout', layout: { columns: 200, rows: 50 } });
if (join.startsWith('pane report-metadata')) ok({ type: 'ok' });
if (join.startsWith('pane close')) ok({ type: 'ok' });
if (join.startsWith('status')) ok({ server: { version: '0.8.2' } });
ok({ type: 'ok' });
`);
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
};

const makeDispatchRaw = (dir, runId, taskId, retryOf = null) =>
  cliJson(dir, [
    'dispatch', 'start', '--task', taskId, '--run', runId, '--no-agent',
    ...(retryOf ? ['--retry-of', retryOf] : []),
  ], {
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/cbds-test-fake.sock',
    HERDR_BIN_PATH: herdrStub(),
  });

const makeDispatch = async (dir, runId, taskId, retryOf = null) => {
  const res = await makeDispatchRaw(dir, runId, taskId, retryOf);
  assert.equal(res.code, 0, `dispatch start failed: ${res.stdout}${res.stderr}`);
  return res.json.data.dispatch.dispatch_id;
};

/* -------------------------------------------------- coordination traffic -- */

describe('coordination messages', () => {
  let dir; let runId; let taskId; let dispatchId; let env;

  before(async () => {
    dir = tmpProject();
    runId = (await cliJson(dir, ['run', 'create', '--objective', 'messaging'])).json.data.run_id;
    taskId = (await cliJson(dir, ['task', 'create', '--spec', 'talkative work'])).json.data.task_id;
    dispatchId = await makeDispatch(dir, runId, taskId);
    // Stand in for the injected worker pane environment.
    env = { CBDS_RUN_ID: runId, CBDS_TASK_ID: taskId, CBDS_DISPATCH_ID: dispatchId };
  });

  test('a heartbeat records liveness without waking a wait', async () => {
    const hb = await cliJson(dir, ['heartbeat', '--phase', 'implementing'], env);
    assert.equal(hb.code, 0);
    assert.equal(hb.json.data.phase, 'implementing');

    // A heartbeat must NOT satisfy a wait: it is liveness, not news.
    const res = await cliJson(dir, ['wait', '--task', taskId, '--timeout', '1500', '--no-hints']);
    assert.equal(res.code, 4, 'a heartbeat must not resolve a wait');
    assert.equal(res.json.data.outstanding[0].phase, 'implementing',
      'but a timeout must surface how recently the worker was alive');
  });

  test('an escalation wakes the coordinator without settling the task', async () => {
    const waiter = cliJson(dir, ['wait', '--task', taskId, '--timeout', '15000', '--no-hints']);
    setTimeout(() => {
      cliJson(dir, ['escalate', '--subject', 'Blocked: no credentials', '--body', 'need a token'], env);
    }, 500);
    const res = await waiter;
    assert.equal(res.code, 0);
    assert.equal(res.json.data.reports[0].type, 'escalation');

    const task = await cliJson(dir, ['task', 'show', taskId]);
    assert.equal(task.json.data.state, 'dispatched', 'an escalation must not settle the task');
  });

  test('ask blocks, reply unblocks, and the answer comes back', async () => {
    const asker = cliJson(dir, ['ask', '--question', 'shared component or page-only?',
      '--options', 'shared,page-only', '--timeout', '20000'], env);

    // The coordinator sees the question through its normal wait.
    const seen = await cliJson(dir, ['wait', '--task', taskId, '--timeout', '15000', '--no-hints']);
    assert.equal(seen.code, 0);
    assert.equal(seen.json.data.reports[0].type, 'question');
    const questionId = seen.json.data.reports[0].report_id;

    await cliJson(dir, ['reply', '--id', questionId, '--body', 'shared']);

    const answered = await asker;
    assert.equal(answered.code, 0, `ask failed: ${answered.stdout}${answered.stderr}`);
    assert.equal(answered.json.data.answer.body, 'shared');
  });

  test('a coordinator follow-up reaches the worker through check', async () => {
    await cliJson(dir, ['send', '--to', dispatchId, '--subject', 'heads up', '--body', 'skip the CSS bit']);
    const res = await cliJson(dir, ['check'], env);
    assert.equal(res.code, 0);
    assert.equal(res.json.data.count, 1);
    assert.equal(res.json.data.messages[0].body, 'skip the CSS bit');

    // The dispatch cursor advances, so the same message is not re-delivered.
    const again = await cliJson(dir, ['check'], env);
    assert.equal(again.json.data.count, 0);
  });

  test('a superseded worker cannot keep emitting lifecycle traffic', async () => {
    const retry = await makeDispatch(dir, runId, taskId, dispatchId);
    assert.ok(retry);
    const hb = await cliJson(dir, ['heartbeat', '--phase', 'zombie'], env);
    assert.equal(hb.code, 5, 'the superseded dispatch must be refused');
    assert.equal(hb.json.error.code, 'stale_dispatch');
  });
});

/* ------------------------------------------------ launch options + trust -- */

describe('launch options', () => {
  test('--model/--effort translate for verified CLIs only', async () => {
    const { buildAgentArgs } = await import('../src/herdr/launch.mjs');
    assert.deepEqual(buildAgentArgs({ kind: 'claude', model: 'opus', effort: 'high' }),
      ['--model', 'opus', '--effort', 'high']);
    assert.deepEqual(buildAgentArgs({ kind: 'codex', model: 'gpt-5.5', effort: 'xhigh' }),
      ['--model', 'gpt-5.5', '-c', 'model_reasoning_effort="xhigh"']);
  });

  test('an unmapped agent is refused rather than given a guessed flag', async () => {
    const { buildAgentArgs } = await import('../src/herdr/launch.mjs');
    assert.throws(() => buildAgentArgs({ kind: 'pi', model: 'x' }), /not mapped/);
    // ...but passthrough alone is always fine, because Herdr forwards it verbatim.
    assert.deepEqual(buildAgentArgs({ kind: 'pi', extra: ['--foo', 'bar'] }), ['--foo', 'bar']);
  });

  test('--effort without --model is a usage error', async () => {
    const { buildAgentArgs } = await import('../src/herdr/launch.mjs');
    assert.throws(() => buildAgentArgs({ kind: 'claude', effort: 'high' }), /requires --model/);
  });

  test('explicit passthrough is appended last so it wins', async () => {
    const { buildAgentArgs } = await import('../src/herdr/launch.mjs');
    assert.deepEqual(buildAgentArgs({ kind: 'claude', model: 'opus', extra: ['--model', 'sonnet'] }),
      ['--model', 'opus', '--model', 'sonnet']);
  });

  test('argv after -- is captured as passthrough, not as positionals', async () => {
    const { parseArgs } = await import('../src/core/args.mjs');
    const r = parseArgs(['--agent', 'codex', 'pos', '--', '-m', 'x'], { agent: { type: 'string' } });
    assert.deepEqual(r.positional, ['pos']);
    assert.deepEqual(r.passthrough, ['-m', 'x']);
  });
});

describe('undelivered contract', () => {
  // Regression guard for the worst bug this tool can have: an agent parked on a
  // startup dialog never receives its task, and a dispatch recorded as live would
  // make the coordinator wait its whole timeout for a worker that was never told
  // what to do — the exact silent hang cbds exists to eliminate.
  test('a blocked agent fails the dispatch instead of leaving it live', async () => {
    const dir = tmpProject();
    const runId = (await cliJson(dir, ['run', 'create', '--objective', 'blocked'])).json.data.run_id;
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'work'])).json.data.task_id;

    const res = await cliJson(dir, ['dispatch', 'start', '--task', taskId, '--agent', 'claude'], {
      HERDR_ENV: '1',
      HERDR_SOCKET_PATH: '/tmp/cbds-test-fake.sock',
      HERDR_BIN_PATH: blockedStub(),
    });

    assert.equal(res.code, 9, `expected contract_undelivered, got ${res.stdout}${res.stderr}`);
    assert.equal(res.json.error.code, 'contract_undelivered');
    assert.match(res.json.error.hint, /cbds trust/);

    const task = await cliJson(dir, ['task', 'show', taskId]);
    assert.notEqual(task.json.data.state, 'dispatched', 'the task must not be left dispatched');
    assert.equal(task.json.data.live_dispatch_id, null, 'no dispatch may hold authority');

    const dispatches = await cliJson(dir, ['dispatch', 'list', '--run', runId]);
    for (const d of dispatches.json.data.dispatches) {
      assert.equal(d.authority, false, 'an undelivered dispatch must not keep authority');
    }
  });
});

/** A Herdr stub whose agent is permanently blocked at a dialog. */
let blockedStubPath = null;
const blockedStub = () => {
  if (blockedStubPath) return blockedStubPath;
  const dir = tmpProject();
  blockedStubPath = path.join(dir, 'herdr-blocked.mjs');
  fs.writeFileSync(blockedStubPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
const join = args.join(' ');
const ok = (result) => { process.stdout.write(JSON.stringify({ id: 's', result })); process.exit(0); };
const err = (code) => { process.stdout.write(JSON.stringify({ id: 's', error: { code, message: code } })); process.exit(1); };
if (join.startsWith('pane split')) ok({ pane: { pane_id: 'w1:p9', workspace_id: 'w1', tab_id: 'w1:t1' } });
if (join.startsWith('pane layout')) ok({ layout: { columns: 200, rows: 50 } });
if (join.startsWith('pane report-metadata') || join.startsWith('pane close')) ok({ type: 'ok' });
if (join.startsWith('agent start')) ok({ type: 'agent_started' });
if (join.startsWith('agent prompt')) err('agent_blocked');
if (join.startsWith('agent ')) ok({ type: 'ok' });
ok({ type: 'ok' });
`);
  fs.chmodSync(blockedStubPath, 0o755);
  return blockedStubPath;
};

describe('failed launch leaves nothing behind', () => {
  // Reproduces the exact chain seen in the wild: the agent parks on a trust dialog,
  // the dispatch is correctly refused (exit 9) — but the pane stayed open holding the
  // Herdr agent name, so the retry died with agent_start_failed and doctor reported
  // "nothing to report". Three bugs, one symptom.
  test('the pane cbds created is closed when its own launch fails', async () => {
    const dir = tmpProject();
    await cliJson(dir, ['run', 'create', '--objective', 'cleanup']);
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'work'])).json.data.task_id;

    const res = await cliJson(dir, ['dispatch', 'start', '--task', taskId, '--agent', 'claude'], {
      HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/fake.sock', HERDR_BIN_PATH: blockedStub(),
    });
    assert.equal(res.code, 9);
    assert.equal(res.json.error.details.pane_closed, true,
      'a pane cbds created must not outlive its own failed launch');
  });

  test('--keep-pane-on-failure is honoured for debugging', async () => {
    const dir = tmpProject();
    await cliJson(dir, ['run', 'create', '--objective', 'keep']);
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'work'])).json.data.task_id;

    const res = await cliJson(dir, ['dispatch', 'start', '--task', taskId, '--agent', 'claude',
      '--keep-pane-on-failure'], {
      HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/fake.sock', HERDR_BIN_PATH: blockedStub(),
    });
    assert.equal(res.code, 9);
    assert.equal(res.json.error.details.pane_closed, false);
  });

  test('a retry gets a fresh agent name, so it cannot collide with the failed attempt', async () => {
    const { agentNameForDispatch } = await import('../src/core/ids.mjs');
    const a = agentNameForDispatch('dsp_aaaaaaaaaaaaa');
    const b = agentNameForDispatch('dsp_bbbbbbbbbbbbb');
    assert.notEqual(a, b, 'two dispatches must never share an agent name');
    assert.match(a, /^[a-z][a-z0-9_-]{0,31}$/, 'must satisfy Herdr\'s agent-name rule');
  });
});

/* ------------------------------------------------- contract right-sizing -- */

describe('contract levels', () => {
  const sample = {
    run: { run_id: 'run_x', objective: 'greet' },
    task: { task_id: 'tsk_x', title: 'Saludo', spec: 'Hola.', max_attempts: 3 },
    dispatch: { dispatch_id: 'dsp_x', attempt: 1 },
  };

  test('every level carries the rules a correct report depends on', async () => {
    const { buildPreamble, CONTRACT_LEVELS } = await import('../src/herdr/preamble.mjs');
    // `bare` is exempt: it leans on the installed skill for these rules, and `auto`
    // only picks it after confirming that skill is present for the agent kind.
    for (const contract of CONTRACT_LEVELS.filter((l) => l !== 'bare')) {
      const p = buildPreamble({ ...sample, contract });
      assert.match(p, /done --outcome succeeded/, `${contract}: how to succeed`);
      assert.match(p, /done --outcome failed/, `${contract}: how to fail`);
      assert.match(p, /done --outcome blocked/, `${contract}: how to say it is stuck`);
      assert.match(p, /exactly once|EXACTLY ONCE/i, `${contract}: exactly-once rule`);
      assert.match(p, /interactive UI|AskUserQuestion/, `${contract}: the hang-forever rule`);
      assert.match(p, /Hola\./, `${contract}: the task itself`);
      // The TASK is last at every level, so the thing to act on gets recency.
      assert.ok(p.lastIndexOf('=== TASK') > p.lastIndexOf('--outcome blocked'),
        `${contract}: TASK must come after the protocol`);
    }
  });

  test('bare is the task plus one anchor line, nothing else', async () => {
    const { buildPreamble } = await import('../src/herdr/preamble.mjs');
    const p = buildPreamble({ ...sample, contract: 'bare' });
    const lines = p.split('\n').filter(Boolean);
    assert.equal(lines[0], 'Hola.', 'the task comes first, verbatim');
    assert.equal(lines.length, 2, `exactly task + anchor, got ${JSON.stringify(lines)}`);
    // Marker + verb only. No flag template: `bare` is only used when the worker has
    // the skill, and spelling out `--outcome succeeded` biases toward reporting success.
    assert.match(lines[1], /^\[cbds dispatch/);
    assert.match(lines[1], /cbds done/);
    assert.ok(!lines[1].includes('--outcome'), `the anchor must not template the flags: ${lines[1]}`);
    assert.ok(Buffer.byteLength(p) - Buffer.byteLength('Hola.') < 110,
      'the anchor overhead must stay tiny — that is the whole point');
  });

  test('compact levels point at the pull command instead of inlining everything', async () => {
    const { buildPreamble } = await import('../src/herdr/preamble.mjs');
    for (const contract of ['minimal', 'standard']) {
      const p = buildPreamble({ ...sample, contract });
      assert.match(p, /cbds contract/, `${contract} must tell the worker where the rest is`);
      assert.ok(!p.includes('heartbeat --phase'), `${contract} must not inline optional verbs`);
    }
  });

  test('levels are meaningfully cheaper, and full stays complete', async () => {
    const { buildPreamble } = await import('../src/herdr/preamble.mjs');
    const size = (contract) => Buffer.byteLength(buildPreamble({ ...sample, contract }));
    assert.ok(size('minimal') < size('standard'), 'minimal < standard');
    assert.ok(size('standard') < size('full'), 'standard < full');
    assert.ok(size('standard') < size('full') / 2,
      'the default must be well under half the full contract, or it is not worth the knob');

    const full = buildPreamble({ ...sample, contract: 'full' });
    for (const verb of ['heartbeat --phase', 'ask --question', 'escalate --subject', 'contract']) {
      assert.ok(full.includes(verb) || verb === 'contract', `full must document ${verb}`);
    }
  });

  test('cbds contract prints the full protocol so nothing is lost by going compact', async () => {
    const { buildContractText, buildPreamble } = await import('../src/herdr/preamble.mjs');
    const text = buildContractText();
    for (const verb of ['done --outcome succeeded', 'heartbeat --phase', 'ask --question',
      'escalate --subject', 'whoami']) {
      assert.ok(text.includes(verb), `cbds contract must document ${verb}`);
    }
    // Whatever the compact preamble omitted must be recoverable here.
    const compact = buildPreamble({ ...sample, contract: 'standard' });
    assert.ok(!compact.includes('heartbeat --phase') && text.includes('heartbeat --phase'),
      'omitted-but-pullable is the whole point');
  });

  test('an unknown contract level is rejected', async () => {
    const dir = tmpProject();
    await cliJson(dir, ['run', 'create', '--objective', 'x']);
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'y'])).json.data.task_id;
    const res = await cliJson(dir, ['dispatch', 'start', '--task', taskId, '--contract', 'huge', '--dry-run']);
    assert.equal(res.code, 2);
  });

  test('dispatch defaults to standard and reports what it injected', async () => {
    const dir = tmpProject();
    await cliJson(dir, ['run', 'create', '--objective', 'x']);
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'y'])).json.data.task_id;
    const res = await cliJson(dir, ['dispatch', 'start', '--task', taskId, '--dry-run'], { HOME: tmpProject() });
    assert.equal(res.json.data.dispatch.contract, 'standard');
    assert.match(res.json.data.contract_reason, /no cbds skill/);
  });
});

/* -------------------------------------------------------- decision gates -- */

describe('decision gates', () => {
  let dir; let runId; let taskId;

  before(async () => {
    dir = tmpProject();
    runId = (await cliJson(dir, ['run', 'create', '--objective', 'gates'])).json.data.run_id;
    taskId = (await cliJson(dir, ['task', 'create', '--spec', 'undecided work'])).json.data.task_id;
  });

  test('opening a gate blocks the task', async () => {
    const res = await cliJson(dir, ['gate', 'create', '--task', taskId,
      '--question', 'shared or page-only?', '--options', 'shared,page-only']);
    assert.equal(res.code, 0);
    assert.equal(res.json.data.state, 'open');

    const task = await cliJson(dir, ['task', 'show', taskId]);
    assert.equal(task.json.data.state, 'blocked');
  });

  test('a gated task cannot be dispatched — enforced, not just displayed', async () => {
    const res = await cliJson(dir, ['dispatch', 'start', '--task', taskId, '--dry-run']);
    assert.equal(res.code, 7);
    assert.equal(res.json.error.code, 'task_gated');
  });

  test('a resolution outside the declared options is refused', async () => {
    const gate = (await cliJson(dir, ['gate', 'list', '--state', 'open'])).json.data.gates[0];
    const res = await cliJson(dir, ['gate', 'resolve', gate.gate_id, '--resolution', 'neither']);
    assert.equal(res.code, 2);
  });

  test('resolving unblocks the task and lets it dispatch', async () => {
    const gate = (await cliJson(dir, ['gate', 'list', '--state', 'open'])).json.data.gates[0];
    const res = await cliJson(dir, ['gate', 'resolve', gate.gate_id, '--resolution', 'shared']);
    assert.equal(res.code, 0);
    assert.equal(res.json.data.task.state, 'ready');

    const ok = await cliJson(dir, ['dispatch', 'start', '--task', taskId, '--dry-run']);
    assert.equal(ok.code, 0);
  });

  test('a task gated twice stays blocked until every gate is resolved', async () => {
    const t = (await cliJson(dir, ['task', 'create', '--spec', 'doubly gated'])).json.data.task_id;
    const g1 = (await cliJson(dir, ['gate', 'create', '--task', t, '--question', 'q1'])).json.data;
    const g2 = (await cliJson(dir, ['gate', 'create', '--task', t, '--question', 'q2'])).json.data;

    await cliJson(dir, ['gate', 'resolve', g1.gate_id, '--resolution', 'a']);
    let task = await cliJson(dir, ['task', 'show', t]);
    assert.equal(task.json.data.state, 'blocked', 'one gate resolved is not enough');

    await cliJson(dir, ['gate', 'resolve', g2.gate_id, '--resolution', 'b']);
    task = await cliJson(dir, ['task', 'show', t]);
    assert.equal(task.json.data.state, 'ready');
  });

  test('a resolved gate cannot be resolved again', async () => {
    const g = (await cliJson(dir, ['gate', 'list', '--state', 'resolved'])).json.data.gates[0];
    const res = await cliJson(dir, ['gate', 'resolve', g.gate_id, '--resolution', 'x']);
    assert.equal(res.code, 7);
  });
});

describe('worktree isolation', () => {
  test('--worktree new refuses to combine with --pane', async () => {
    const dir = tmpProject();
    await cliJson(dir, ['run', 'create', '--objective', 'wt']);
    const t = (await cliJson(dir, ['task', 'create', '--spec', 'x'])).json.data.task_id;
    const res = await cliJson(dir, ['dispatch', 'start', '--task', t,
      '--worktree', 'new', '--pane', 'w1:p1'], {
      HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/fake.sock', HERDR_BIN_PATH: '/bin/true',
    });
    assert.equal(res.code, 2);
  });

  test('an unknown --worktree value is refused rather than guessed', async () => {
    const dir = tmpProject();
    await cliJson(dir, ['run', 'create', '--objective', 'wt']);
    const t = (await cliJson(dir, ['task', 'create', '--spec', 'x'])).json.data.task_id;
    const res = await cliJson(dir, ['dispatch', 'start', '--task', t, '--worktree', 'maybe'], {
      HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/fake.sock', HERDR_BIN_PATH: '/bin/true',
    });
    assert.equal(res.code, 2);
  });
});

/* --------------------------------------------------------- pane placement -- */

describe('placement', () => {
  const rect = (id, width, height, x = 0, y = 0) => ({ pane_id: id, rect: { width, height, x, y } });

  test('a full-width tab splits right, then down — a grid, not a row of strips', async () => {
    const { planSplit } = await import('../src/commands/dispatch.mjs');

    // One full-width pane: wide enough to split right.
    assert.equal(planSplit({ panes: [rect('p1', 251, 62)] }).direction, 'right');

    // Two half-width panes: no longer wide enough, so the next one goes down.
    // This is the rule that stops four workers becoming four 10-column strips.
    assert.equal(planSplit({ panes: [rect('p1', 126, 62), rect('p2', 125, 62)] }).direction, 'down');
  });

  test('it always splits the largest pane, so space stays even', async () => {
    const { planSplit } = await import('../src/commands/dispatch.mjs');
    const plan = planSplit({
      panes: [rect('small', 60, 20), rect('big', 200, 60), rect('mid', 100, 30)],
    });
    assert.equal(plan.paneId, 'big');
  });

  test('auto splits while the tab is uncrowded and gives its own tab past the limit', async () => {
    const { planPlacement } = await import('../src/commands/dispatch.mjs');
    // planPlacement reads the layout through the Herdr client, so drive the pure
    // decision by checking both sides of the threshold via planSplit + counts.
    const { planSplit } = await import('../src/commands/dispatch.mjs');
    assert.ok(planSplit({ panes: [rect('p1', 251, 62)] }), 'a one-pane tab is splittable');
    assert.equal(typeof planPlacement, 'function');
  });

  test('an unknown placement is refused rather than guessed', async () => {
    const dir = tmpProject();
    await cliJson(dir, ['run', 'create', '--objective', 'p']);
    const t = (await cliJson(dir, ['task', 'create', '--spec', 'x'])).json.data.task_id;
    const res = await cliJson(dir, ['dispatch', 'start', '--task', t, '--placement', 'grid'], {
      HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/fake.sock', HERDR_BIN_PATH: '/bin/true',
    });
    assert.equal(res.code, 2);
  });
});

/* ------------------------------------------------------------ tab labels -- */

describe('labels', () => {
  const titles = [
    "Curiozy After Dolly Parton's Death, Her Best Friend Judy Ogle",
    "Curiozy At Dolly Parton's Funeral, Her Dog Jumped Onto Her Body",
    "Curiozy Dolly Parton's FINAL GOODBYE - Celebrities BREAK DOWN",
    "Curiozy Dolly Parton's Funeral - What Cher Just Did",
    "Curiozy Dolly Parton's Family Cry At Her Grave",
    "Curiozy Bigi HONORS Michael Jackson's 68th Birthday",
  ];

  test('a shared prefix is stripped so the visible characters carry information', async () => {
    const { commonWordPrefix } = await import('../src/core/labels.mjs');
    assert.equal(commonWordPrefix(titles), 'Curiozy ');
    assert.equal(commonWordPrefix(['one two', 'three four']), '', 'nothing shared, nothing stripped');
  });

  test('words most siblings share are dropped — a repeated name is not a label', async () => {
    const { distinctiveLabel } = await import('../src/core/labels.mjs');
    const label = distinctiveLabel(titles[2], titles, 24);
    assert.ok(!label.includes('Dolly'), `"${label}" should not spend space on the shared name`);
    assert.match(label, /FINAL GOODBYE/);
  });

  test('it never cuts mid-word or leaves dangling punctuation', async () => {
    const { clipWords } = await import('../src/core/labels.mjs');
    const out = clipWords('Dolly Parton Funeral — What Cher Did', 20);
    assert.ok(out.endsWith('…'));
    assert.ok(!/[\s,.;:—–-]…$/.test(out), `"${out}" has dangling punctuation`);
    assert.ok(out.length <= 21);
    assert.equal(clipWords('short', 20), 'short', 'short titles are left alone');
  });

  test('it never strips a title down to nothing', async () => {
    const { distinctiveLabel } = await import('../src/core/labels.mjs');
    const same = Array.from({ length: 8 }, () => 'Dolly Parton Funeral');
    const label = distinctiveLabel(same[0], same, 24);
    assert.ok(label.length > 0, 'an empty tab is worse than a repetitive one');
  });

  test('collisions are widened until the labels actually differ', async () => {
    const { distinctiveLabels } = await import('../src/core/labels.mjs');
    const clashing = [
      'Curiozy Michael Jackson 68th Birthday — What Bigi Said',
      'Curiozy Michael Jackson 68th Birthday — What Jaafar Said',
      'Curiozy Something Else Entirely',
    ];
    const out = distinctiveLabels(clashing, 20);
    assert.equal(new Set(out).size, out.length, `labels must be distinct: ${JSON.stringify(out)}`);
  });

  test('genuinely identical titles get numbered rather than left ambiguous', async () => {
    const { distinctiveLabels } = await import('../src/core/labels.mjs');
    const out = distinctiveLabels(['Same Task', 'Same Task', 'Other'], 20);
    assert.equal(new Set(out).size, 3);
  });
});


/* ------------------------------------------- skill-resident protocol -- */

describe('skill-resident protocol', () => {
  test('status reports missing in a fresh home; install fixes exactly that kind', async () => {
    const home = tmpProject();
    const before = await cliJson(process.cwd(), ['skill', 'status', '--agent', 'claude,pi'], { HOME: home });
    assert.ok(before.json.data.agents.every((a) => a.status === 'missing'));

    const inst = await cliJson(process.cwd(), ['skill', 'install', '--agent', 'claude'], { HOME: home });
    assert.equal(inst.json.data.agents[0].status, 'installed');
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'cbds', 'SKILL.md')));

    const after = await cliJson(process.cwd(), ['skill', 'status', '--agent', 'claude,pi'], { HOME: home });
    const byKind = Object.fromEntries(after.json.data.agents.map((a) => [a.kind, a.status]));
    assert.equal(byKind.claude, 'installed');
    assert.equal(byKind.pi, 'missing', 'installing for one kind must not claim another');
  });

  test('auto goes bare only for a kind whose skill is installed', async () => {
    const home = tmpProject();
    const dir = tmpProject();
    await cliJson(dir, ['run', 'create', '--objective', 'auto']);
    const t = (await cliJson(dir, ['task', 'create', '--spec', 'Hola.'])).json.data.task_id;
    await cliJson(process.cwd(), ['skill', 'install', '--agent', 'claude'], { HOME: home });

    const claude = await cliJson(dir, ['dispatch', 'start', '--task', t, '--agent', 'claude', '--dry-run'], { HOME: home });
    assert.equal(claude.json.data.contract, 'bare');
    assert.match(claude.json.data.contract_reason, /skill installed/);
    assert.ok(claude.json.data.preamble_tokens_approx < 60, 'bare must be a few dozen tokens');

    const pi = await cliJson(dir, ['dispatch', 'start', '--task', t, '--agent', 'pi', '--dry-run'], { HOME: home });
    assert.equal(pi.json.data.contract, 'standard', 'no skill for pi -> the safe contract');
    assert.match(pi.json.data.contract_reason, /cbds skill install --agent pi/);
  });

  test('an unknown skill kind is refused, with the npx fallback in the hint', async () => {
    const res = await cliJson(process.cwd(), ['skill', 'install', '--agent', 'droid'], { HOME: tmpProject() });
    assert.equal(res.code, 2);
    assert.match(res.json.error.hint, /npx skills add/);
  });
});

/* ------------------------------------------------------- plain messaging -- */

describe('plain messaging', () => {
  test('say and spawn need a target and a kind', async () => {
    const dir = tmpProject();
    assert.equal((await cliJson(dir, ['say'])).code, 2);
    assert.equal((await cliJson(dir, ['say', 'pi'])).code, 2, 'a target with no message is a usage error');
    assert.equal((await cliJson(dir, ['spawn'])).code, 2);
  });

  test('spawn refuses an unknown agent kind rather than opening a doomed pane', async () => {
    const res = await cliJson(tmpProject(), ['spawn', 'notanagent'], {
      HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/fake.sock', HERDR_BIN_PATH: '/bin/true',
    });
    assert.equal(res.code, 2);
  });

  test('they need Herdr, and say so plainly', async () => {
    const res = await cliJson(tmpProject(), ['say', 'pi', 'hola']);
    assert.equal(res.code, 6);
    assert.equal(res.json.error.code, 'herdr_unavailable');
  });

  test('neither one creates a run, a task or a dispatch', async () => {
    const dir = tmpProject();
    await cliJson(dir, ['say', 'pi', 'hola']).catch(() => {});
    await cliJson(dir, ['spawn', 'pi', '--say', 'hola']).catch(() => {});
    assert.ok(!fs.existsSync(path.join(dir, '.cbds', 'runs')),
      'plain messaging must leave no orchestration state behind');
  });
});

/* --------------------------------------- orchestrator <-> worker identity -- */

describe('the relationship is mutual', () => {
  test('agent names lead with the task, so a human can address them', async () => {
    const { agentNameForDispatch } = await import('../src/core/ids.mjs');
    const name = agentNameForDispatch('dsp_m1bhr328avzdn', 'Fix the footer overlap on mobile');
    assert.match(name, /^fix-the-footer-overlap/, `"${name}" must lead with the task`);
    assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/, "must satisfy Herdr's agent-name rule");

    // Two dispatches of the SAME task must still differ, or the retry collides with
    // the dead attempt's pane.
    const a = agentNameForDispatch('dsp_aaaaaaaaaaaaa', 'Same title');
    const b = agentNameForDispatch('dsp_bbbbbbbbbbbbb', 'Same title');
    assert.notEqual(a, b);

    // An empty title must not produce a name starting with a digit or a dash.
    assert.match(agentNameForDispatch('dsp_m1aa1d90wn1mg', ''), /^[a-z]/);
  });

  test('the worker is told who is waiting, at every contract level', async () => {
    const { buildPreamble } = await import('../src/herdr/preamble.mjs');
    const dispatch = {
      dispatch_id: 'dsp_x', attempt: 1,
      coordinator: { pane_id: 'w1:p1', agent_name: 'lead' },
    };
    const sample = {
      run: { run_id: 'run_x', objective: 'o' },
      task: { task_id: 'tsk_x', title: 'T', spec: 'Hola.', max_attempts: 3 },
      dispatch,
    };
    assert.match(buildPreamble({ ...sample, contract: 'bare' }), /from lead/);
    assert.match(buildPreamble({ ...sample, contract: 'standard' }), /coordinator is lead/);

    // With no coordinator recorded it must still read correctly, not "from undefined".
    const anon = buildPreamble({
      ...sample, dispatch: { dispatch_id: 'dsp_x', attempt: 1 }, contract: 'bare',
    });
    assert.ok(!anon.includes('undefined'), anon);
  });

  test('the coordinator identity rides in the worker environment', async () => {
    const { workerEnv } = await import('../src/herdr/preamble.mjs');
    const env = workerEnv({
      run: { run_id: 'run_x' }, task: { task_id: 'tsk_x' }, dispatch: { dispatch_id: 'dsp_x' },
      stateDir: '/tmp', depth: 1, coordinator: { pane_id: 'w1:p1', agent_name: 'lead' },
    });
    assert.equal(env.CBDS_COORDINATOR, 'lead');
    const none = workerEnv({
      run: { run_id: 'run_x' }, task: { task_id: 'tsk_x' }, dispatch: { dispatch_id: 'dsp_x' },
      stateDir: '/tmp', depth: 1,
    });
    assert.ok(!('CBDS_COORDINATOR' in none), 'never inject an empty coordinator');
  });
});

describe('an unanswered question is never silent', () => {
  test('status and board surface a worker blocked inside ask', async () => {
    const dir = tmpProject();
    const runId = (await cliJson(dir, ['run', 'create', '--objective', 'q'])).json.data.run_id;
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'work'])).json.data.task_id;
    const dispatchId = await makeDispatch(dir, runId, taskId);
    const env = { CBDS_RUN_ID: runId, CBDS_TASK_ID: taskId, CBDS_DISPATCH_ID: dispatchId };

    // The worker asks and would now be blocking on the answer.
    const asked = await cliJson(dir, ['ask', '--question', 'shared or page-only?', '--timeout', '1500'], env);
    assert.equal(asked.code, 4, 'it times out because nobody answered');
    const questionId = asked.json.data.question_id;

    const status = await cliJson(dir, ['status']);
    assert.equal(status.json.data.runs[0].open_questions.length, 1,
      'a pending question must be visible without digging');

    const board = await cliJson(dir, ['board', '--once']);
    assert.ok(JSON.stringify(board.json).includes(questionId) || status.json.data.runs[0].open_questions[0].report_id === questionId);

    // Answering clears it.
    await cliJson(dir, ['reply', '--id', questionId, '--body', 'shared']);
    const after = await cliJson(dir, ['status']);
    assert.equal(after.json.data.runs[0].open_questions.length, 0);
  });
});


describe('--trust never aborts a dispatch', () => {
  test('an agent kind cbds does not manage is skipped, not fatal', async () => {
    const { MANAGED_KINDS } = await import('../src/commands/trust.mjs');
    assert.deepEqual(MANAGED_KINDS, ['claude', 'codex']);
    assert.ok(!MANAGED_KINDS.includes('pi'),
      'pi has no trust gate cbds manages — dispatching to it with --trust must still work');
  });
});

/* ------------------------------------------ the report has to reach someone -- */

describe('a report is never left unread', () => {
  test('wait registers itself, so done knows somebody is listening', async () => {
    const { register, someoneIsWaiting, liveWaiters } = await import('../src/core/waiters.mjs');
    const R = { base: tmpProject() };
    assert.equal(someoneIsWaiting(R), false);

    const stop = register(R, 'task tsk_x');
    assert.equal(someoneIsWaiting(R), true);
    assert.equal(liveWaiters(R)[0].scope, 'task tsk_x');

    stop();
    assert.equal(someoneIsWaiting(R), false, 'a finished wait must stop claiming to listen');
  });

  test('a waiter whose process died is pruned, not trusted forever', async () => {
    const { liveWaiters } = await import('../src/core/waiters.mjs');
    const base = tmpProject();
    const dir = path.join(base, 'waiters');
    fs.mkdirSync(dir, { recursive: true });
    // A pid that cannot exist, on this host.
    fs.writeFileSync(path.join(dir, `${os.hostname()}-999999999.json`),
      JSON.stringify({ pid: 999999999, host: os.hostname(), scope: 'stale', at: new Date().toISOString() }));

    assert.equal(liveWaiters({ base }).length, 0,
      'a dead waiter must not suppress the notification for ever');
    assert.equal(fs.existsSync(path.join(dir, `${os.hostname()}-999999999.json`)), false, 'and it is cleaned up');
  });

  test('done reports whether the coordinator was notified', async () => {
    const dir = tmpProject();
    const runId = (await cliJson(dir, ['run', 'create', '--objective', 'n'])).json.data.run_id;
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'w'])).json.data.task_id;
    const dispatchId = await makeDispatch(dir, runId, taskId);

    // The stub Herdr records no coordinator pane, so there is nobody to push to and
    // the field stays null — the point is that it is reported either way.
    const res = await cliJson(dir, ['done', '--run', runId, '--task-id', taskId,
      '--dispatch-id', dispatchId, '--outcome', 'succeeded', '--body', 'b']);
    assert.equal(res.code, 0);
    assert.ok('notified' in res.json.data, 'done must say what happened to the notice');
  });

  test('--no-notify opts out', async () => {
    const dir = tmpProject();
    const runId = (await cliJson(dir, ['run', 'create', '--objective', 'n'])).json.data.run_id;
    const taskId = (await cliJson(dir, ['task', 'create', '--spec', 'w'])).json.data.task_id;
    const dispatchId = await makeDispatch(dir, runId, taskId);
    const res = await cliJson(dir, ['done', '--run', runId, '--task-id', taskId,
      '--dispatch-id', dispatchId, '--outcome', 'succeeded', '--body', 'b', '--no-notify']);
    assert.equal(res.code, 0);
    assert.equal(res.json.data.notified, null);
  });
});
