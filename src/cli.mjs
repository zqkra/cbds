import { parseArgs, renderFlags } from './core/args.mjs';
import { CbdsError, EXIT, usage } from './core/errors.mjs';
import { emitError, c, table } from './core/output.mjs';
import { buildContext } from './core/context.mjs';

import * as runCmd from './commands/run.mjs';
import * as taskCmd from './commands/task.mjs';
import * as dispatchCmd from './commands/dispatch.mjs';
import * as reportCmd from './commands/report.mjs';
import { done, whoami } from './commands/done.mjs';
import { wait } from './commands/wait.mjs';
import { status } from './commands/status.mjs';
import { board } from './commands/board.mjs';
import { doctor } from './commands/doctor.mjs';
import { release, retain } from './commands/lifecycle.mjs';
import { heartbeat, ask, escalate, check, reply, send } from './commands/messaging.mjs';
import { trust } from './commands/trust.mjs';
import { contract } from './commands/contract.mjs';
import * as gateCmd from './commands/gate.mjs';

export const VERSION = '1.6.0';

/** Flags accepted by every command. */
const GLOBAL_FLAGS = {
  json: { type: 'boolean', describe: 'stable machine-readable output' },
  run: { type: 'string', placeholder: 'run_id', describe: 'operate on this run' },
  'state-dir': { type: 'string', placeholder: 'path', describe: 'override the state directory' },
  global: { type: 'boolean', describe: 'use the per-user state dir instead of ./.cbds' },
  quiet: { type: 'boolean', alias: 'q', describe: 'suppress human output' },
  help: { type: 'boolean', alias: 'h', describe: 'show help for this command' },
};

/**
 * The command tree. Groups map a subcommand name to a command object; leaves are
 * command objects directly. Keeping this declarative is what lets --help, completion
 * and the plugin actions all read from one source.
 */
const TREE = {
  run: {
    describe: 'durable namespaces and coordinator inboxes',
    sub: {
      create: runCmd.create, list: runCmd.list, show: runCmd.show,
      status: runCmd.status, close: runCmd.close, use: runCmd.use,
    },
  },
  task: {
    describe: 'work items and their lifecycle',
    sub: {
      create: taskCmd.create, list: taskCmd.list, show: taskCmd.show,
      update: taskCmd.update, cancel: taskCmd.cancel,
    },
  },
  dispatch: {
    describe: 'bind a task attempt to a Herdr pane',
    sub: {
      start: dispatchCmd.start, list: dispatchCmd.list,
      show: dispatchCmd.show, cancel: dispatchCmd.cancel,
    },
  },
  gate: {
    describe: 'coordinator decisions that block a task',
    sub: {
      create: gateCmd.create, list: gateCmd.list,
      resolve: gateCmd.resolve, cancel: gateCmd.cancel,
    },
  },
  report: {
    describe: 'the run inbox',
    sub: { list: reportCmd.list, show: reportCmd.show, ack: reportCmd.ack },
  },
  done,
  wait,
  whoami,
  status,
  board,
  doctor,
  release,
  retain,
  heartbeat,
  ask,
  escalate,
  check,
  reply,
  send,
  trust,
  contract,
};

const isCommand = (node) => node && typeof node.run === 'function';

const commandHelp = (pathParts, cmd) => {
  const lines = [
    `${c.bold(`cbds ${pathParts.join(' ')}`)} — ${cmd.summary}`,
    '',
    `${c.dim('usage')}  ${cmd.usage}`,
  ];
  const own = renderFlags(cmd.flags ?? {});
  if (own) lines.push('', c.dim('options'), own);
  lines.push('', c.dim('global options'), renderFlags(GLOBAL_FLAGS));
  if (cmd.notes) lines.push('', c.dim('notes'), cmd.notes);
  return lines.join('\n');
};

const groupHelp = (name, group) => {
  const rows = Object.entries(group.sub).map(([sub, cmd]) => ({ sub, cmd }));
  return [
    `${c.bold(`cbds ${name}`)} — ${group.describe}`,
    '',
    table(rows, [
      { header: 'COMMAND', get: (r) => c.bold(r.sub) },
      { header: 'SUMMARY', get: (r) => r.cmd.summary },
    ]),
    '',
    c.dim(`run \`cbds ${name} <command> --help\` for details`),
  ].join('\n');
};

const rootHelp = () => {
  const leaves = Object.entries(TREE).filter(([, n]) => isCommand(n));
  const groups = Object.entries(TREE).filter(([, n]) => !isCommand(n));
  return [
    `${c.bold('cbds')} ${c.dim(`v${VERSION}`)} — reliable multi-agent orchestration for the Herdr herd`,
    '',
    c.dim('  Orchestrators send work with `dispatch start` and receive it with `wait`.'),
    c.dim('  Workers report exactly once with `done`. The durable report is the truth;'),
    c.dim('  the terminal is only a hint.'),
    '',
    c.dim('command groups'),
    table(groups.map(([name, g]) => ({ name, g })), [
      { header: 'GROUP', get: (r) => c.bold(r.name) },
      { header: 'DESCRIPTION', get: (r) => r.g.describe },
    ]),
    '',
    c.dim('commands'),
    table(leaves.map(([name, cmd]) => ({ name, cmd })), [
      { header: 'COMMAND', get: (r) => c.bold(r.name) },
      { header: 'SUMMARY', get: (r) => r.cmd.summary },
    ]),
    '',
    c.dim('typical orchestrator loop'),
    '  cbds run create --objective "<what this run is for>"',
    '  cbds task create --spec "<the work>"',
    '  cbds dispatch start --task <task_id> --agent claude',
    '  cbds wait --task <task_id> --timeout 900000',
    '  cbds release <dispatch_id>',
    '',
    c.dim('typical worker loop'),
    '  cbds whoami                                    # am I really a live worker?',
    '  cbds heartbeat --phase implementing            # every ~5 min on long work',
    '  cbds ask --question "…" --timeout 600000       # blocking question to the coordinator',
    '  cbds done --outcome succeeded --body "…"       # exactly once, even on failure',
    '',
    c.dim(`exit codes: 0 ok · 2 usage · 3 not found · 4 timeout · 5 stale dispatch · 6 no herdr · 7 conflict · 8 worker vanished`),
  ].join('\n');
};

export const main = async (argv) => {
  let ctx = null;
  try {
    if (argv.includes('--version') || argv.includes('-V')) {
      process.stdout.write(`cbds ${VERSION}\n`);
      return EXIT.OK;
    }

    const parts = [];
    let node = TREE;
    let i = 0;
    while (i < argv.length && !argv[i].startsWith('-')) {
      const next = isCommand(node) ? null : node[argv[i]] ?? node.sub?.[argv[i]];
      if (!next) break;
      parts.push(argv[i]);
      node = next;
      i += 1;
      if (isCommand(node)) break;
    }

    const wantsHelp = argv.includes('--help') || argv.includes('-h');

    if (!parts.length) {
      if (argv.length && !argv[0].startsWith('-')) {
        throw usage(`unknown command: ${argv[0]}`, 'run `cbds --help` to see the command list');
      }
      process.stdout.write(`${rootHelp()}\n`);
      return wantsHelp || !argv.length ? EXIT.OK : EXIT.USAGE;
    }

    if (!isCommand(node)) {
      // A group with no subcommand, or an unrecognised subcommand under it.
      if (i < argv.length && !argv[i].startsWith('-')) {
        throw usage(`unknown subcommand: ${parts.join(' ')} ${argv[i]}`,
          `valid: ${Object.keys(node.sub).join(', ')}`);
      }
      process.stdout.write(`${groupHelp(parts.join(' '), node)}\n`);
      return wantsHelp ? EXIT.OK : EXIT.USAGE;
    }

    if (wantsHelp) {
      process.stdout.write(`${commandHelp(parts, node)}\n`);
      return EXIT.OK;
    }

    const spec = { ...GLOBAL_FLAGS, ...(node.flags ?? {}) };
    const { flags, positional, passthrough } = parseArgs(argv.slice(i), spec);
    ctx = buildContext({ commandName: parts.join('.'), flags, positional, passthrough });

    await node.run(ctx);
    return process.exitCode ?? EXIT.OK;
  } catch (err) {
    if (err instanceof CbdsError) {
      emitError(ctx, err);
      return err.exit;
    }
    // Anything else is a bug, not an expected condition. Say so plainly.
    emitError(ctx, new CbdsError('internal_error', err?.message ?? String(err), {
      exit: EXIT.FAILURE,
      details: { stack: (err?.stack ?? '').split('\n').slice(0, 6) },
    }));
    return EXIT.FAILURE;
  }
};
