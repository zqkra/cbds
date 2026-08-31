import { requireFlag, oneOf } from '../core/args.mjs';
import { usage, noHerdr, CbdsError, EXIT } from '../core/errors.mjs';
import { emit, say, kv, c, truncate } from '../core/output.mjs';
import {
  paneSplit, agentStart, agentPrompt, agentGet, agentList, paneGet,
  insideHerdr, callerPane, agentKinds, KNOWN_AGENT_KINDS, paintPane,
} from '../herdr/client.mjs';
import { resolveRun, resolveDispatchId } from '../core/context.mjs';
import { loadDispatch, listDispatches, listTasks } from '../core/model.mjs';

/**
 * Plain messaging: no Run, no Task, no Dispatch, no completion contract.
 *
 * cbds began with a single verb, and a system with one verb makes everything look
 * like its verb: asked to have two agents greet each other, it wrapped "hola" in a
 * completion contract. Orca and Plano both carry two — `send` for a message, and a
 * dispatch/`ask` for something you will wait on. Herdr has the same split natively.
 *
 * So this is the plain half. It sends the text and nothing else. If you find yourself
 * wanting a structured, authenticated result back, that is a dispatch — use it.
 */

const resolveTarget = (ctx, target) => {
  // A task or dispatch id addresses whoever is currently working it. That is the bit
  // raw Herdr cannot do: it knows panes, not what a pane is working on.
  if (/^(tsk|dsp)_/.test(target)) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    if (target.startsWith('dsp_')) {
      const d = loadDispatch(store, run.run_id, resolveDispatchId(store, run.run_id, target));
      return { target: d.target.agent_name ?? d.target.pane_id, via: `dispatch ${d.dispatch_id}` };
    }
    const live = listDispatches(store, run.run_id)
      .filter((d) => d.task_id.endsWith(target.replace(/^tsk_/, '')) || d.task_id === target)
      .filter((d) => d.state === 'dispatched')
      .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    if (!live) {
      throw new CbdsError('no_live_worker', `no live worker for task ${target}`, {
        exit: EXIT.NOT_FOUND, hint: 'dispatch it first, or address the pane id directly',
      });
    }
    return { target: live.target.agent_name ?? live.target.pane_id, via: `task ${live.task_id}` };
  }
  return { target, via: null };
};

export const talkSay = {
  summary: 'Send a plain message to an agent — no task, no contract, just the text',
  usage: 'cbds say <pane_id|agent_name|task_id|dispatch_id> "<message>"',
  flags: {
    wait: { type: 'boolean', describe: 'block until that agent finishes its turn' },
    timeout: { type: 'number', default: 120000, placeholder: 'ms', describe: 'used with --wait' },
  },
  async run(ctx) {
    const [rawTarget, ...rest] = ctx.positional;
    if (!rawTarget) throw usage('cbds say <target> "<message>"');
    const text = rest.join(' ').trim();
    if (!text) throw usage('nothing to say', 'cbds say <target> "<message>"');
    if (!insideHerdr() && !process.env.HERDR_SOCKET_PATH) {
      throw noHerdr('cbds say needs a running Herdr session');
    }

    const { target, via } = resolveTarget(ctx, rawTarget);
    const res = await agentPrompt({
      target, text, wait: Boolean(ctx.flags.wait), timeoutMs: ctx.flags.timeout,
    });

    const blocked = res?._allowed === 'agent_blocked';
    say(ctx, blocked
      ? `${c.yellow('not delivered')}  ${target} is sitting at a dialog`
      : `${c.green('sent')}  ${c.bold(target)}${via ? c.dim(`  (${via})`) : ''}`);
    if (blocked) say(ctx, c.dim(`  clear it, then retry — cbds say does not force input past an approval prompt`));
    return emit(ctx, { target, via, delivered: !blocked, waited: Boolean(ctx.flags.wait), text });
  },
};

export const talkSpawn = {
  summary: 'Open an agent in a new pane and optionally say something — no task, no contract',
  usage: 'cbds spawn <kind> [--say "<message>"] [--cwd <path>]',
  flags: {
    say: { type: 'string', describe: 'a message to send once it is ready' },
    cwd: { type: 'string', placeholder: 'path', describe: 'working directory' },
    name: { type: 'string', describe: 'agent name (default: derived from the kind)' },
    direction: { type: 'string', describe: 'right|down (default: from pane geometry)' },
    focus: { type: 'boolean', default: false, describe: 'move focus to it' },
    'startup-timeout': { type: 'number', default: 60000, placeholder: 'ms' },
    wait: { type: 'boolean', describe: 'block until it finishes its first turn' },
  },
  async run(ctx) {
    const kind = ctx.positional[0];
    if (!kind) throw usage('cbds spawn <kind> [--say "<message>"]', `kinds: ${KNOWN_AGENT_KINDS.slice(0, 8).join(', ')}…`);
    const { kinds, source } = await agentKinds();
    if (!kinds.includes(kind)) {
      throw usage(`unknown agent kind "${kind}"`,
        `kinds supported by ${source === 'herdr' ? 'your Herdr' : 'cbds'}: ${kinds.join(', ')}`);
    }
    if (!insideHerdr() && !process.env.HERDR_SOCKET_PATH) {
      throw noHerdr('cbds spawn needs a running Herdr session');
    }

    const cwd = ctx.flags.cwd ?? process.cwd();
    const existing = new Set(((await agentList().catch(() => null))?.agents ?? [])
      .map((a) => a.name).filter(Boolean));
    let name = ctx.flags.name ?? kind;
    for (let n = 2; existing.has(name); n += 1) name = `${kind}-${n}`;

    const direction = ctx.flags.direction ? oneOf(ctx.flags.direction, ['right', 'down'], 'direction') : 'right';
    const split = await paneSplit({
      targetPaneId: callerPane().pane_id, direction, cwd, focus: ctx.flags.focus,
    });
    const pane = split?.pane ?? split;

    let ready = true;
    try {
      const started = await agentStart({
        name, kind, paneId: pane.pane_id, timeoutMs: ctx.flags['startup-timeout'],
      });
      if (started?._allowed) ready = false;
    } catch (err) {
      throw new CbdsError('spawn_failed', `started a pane but ${kind} did not come up: ${err.message}`, {
        exit: EXIT.NO_HERDR,
        details: { pane_id: pane.pane_id },
        hint: `the pane is open at ${pane.pane_id}; inspect or close it`,
      });
    }

    await paintPane(pane.pane_id, { title: name });

    let sent = false;
    if (ctx.flags.say) {
      // The message goes out exactly as written. Nothing is appended: this is not a
      // dispatch, so there is no report to ask for.
      const res = await agentPrompt({
        target: name, text: ctx.flags.say,
        wait: Boolean(ctx.flags.wait), timeoutMs: ctx.flags.timeout ?? 120000,
      });
      sent = res?._allowed !== 'agent_blocked';
    }

    say(ctx, `${c.green('spawned')}  ${c.bold(name)}  ${c.dim(`${kind} in ${pane.pane_id}`)}`);
    say(ctx, kv([
      ['pane', pane.pane_id],
      ['cwd', cwd],
      ['ready', ready ? 'yes' : c.yellow('not ready (blocked at a dialog?)')],
      ['message', ctx.flags.say ? `${sent ? c.green('sent') : c.yellow('not delivered')}  ${c.dim(truncate(ctx.flags.say, 44))}` : null],
    ]));
    say(ctx, c.dim(`\n  talk to it:   cbds say ${name} "<message>"`));
    say(ctx, c.dim(`  read it:      herdr agent read ${name}`));
    say(ctx, c.dim(`  close it:     herdr pane close ${pane.pane_id}`));

    return emit(ctx, {
      agent: { name, kind, ready },
      pane: { pane_id: pane.pane_id, workspace_id: pane.workspace_id ?? null, tab_id: pane.tab_id ?? null },
      cwd, message_sent: sent,
    });
  },
};

export const who = {
  summary: 'Who is running right now — agents, and which are cbds workers',
  usage: 'cbds who',
  flags: {},
  async run(ctx) {
    const agents = (await agentList().catch(() => null))?.agents ?? [];
    let workers = new Map();
    try {
      const run = resolveRun(ctx, { required: false });
      if (run) {
        const store = ctx.store();
        const tasks = Object.fromEntries(listTasks(store, run.run_id).map((t) => [t.task_id, t]));
        for (const d of listDispatches(store, run.run_id)) {
          if (d.state === 'dispatched' && d.target?.pane_id) {
            workers.set(d.target.pane_id, { dispatch: d, task: tasks[d.task_id] });
          }
        }
      }
    } catch { /* no store here; plain agent list is still useful */ }

    const rows = agents.map((a) => {
      const w = workers.get(a.pane_id);
      return {
        name: a.name ?? c.dim('(unnamed)'),
        pane: a.pane_id,
        kind: a.agent ?? '?',
        status: a.agent_status ?? '?',
        role: w ? `cbds · ${truncate(w.task?.title ?? w.dispatch.task_id, 28)}` : c.dim('free'),
      };
    });

    if (!rows.length) say(ctx, c.dim('  no agents running'));
    else {
      const { table } = await import('../core/output.mjs');
      say(ctx, table(rows, [
        { header: 'AGENT', get: (r) => c.bold(r.name) },
        { header: 'PANE', get: (r) => r.pane },
        { header: 'KIND', get: (r) => r.kind },
        { header: 'STATE', get: (r) => r.status },
        { header: 'DOING', get: (r) => r.role },
      ]));
    }
    return emit(ctx, { count: rows.length, agents: rows });
  },
};
