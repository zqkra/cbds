import { requireFlag, oneOf, csv } from '../core/args.mjs';
import { CbdsError, EXIT, conflict, usage, noHerdr } from '../core/errors.mjs';
import { emit, say, table, kv, c, paintState, relTime, truncate } from '../core/output.mjs';
import {
  loadTask, saveTask, listDispatches, loadDispatch, saveDispatch,
  createDispatch, supersedeDispatch, depsSatisfied, reconcileTaskReadiness, DISPATCH_STATES,
} from '../core/model.mjs';
import { resolveRun, resolveTaskId, resolveDispatchId } from '../core/context.mjs';
import { agentNameForDispatch } from '../core/ids.mjs';
import { appendEvent } from '../core/store.mjs';
import { buildPreamble, sha256, workerEnv } from '../herdr/preamble.mjs';
import { buildAgentArgs, launchKinds } from '../herdr/launch.mjs';
import {
  paneSplit, agentStart, agentPrompt, paneLayout, paneGet, paintPane, insideHerdr, callerPane,
  agentKinds, KNOWN_AGENT_KINDS, agentGet, agentWait,
} from '../herdr/client.mjs';

/**
 * Herdr's own guidance: split a wide pane to the right, a narrow or tall one down.
 * Repeated same-direction splits produce unusable columns, so this is worth doing.
 */
const chooseDirection = async (paneId) => {
  try {
    const layout = await paneLayout(paneId);
    const pane = layout?.layout ?? layout?.pane ?? layout;
    const cols = pane?.columns ?? pane?.width ?? pane?.cols;
    const rows = pane?.rows ?? pane?.height;
    if (typeof cols === 'number' && typeof rows === 'number') {
      return cols >= rows * 2.2 ? 'right' : 'down';
    }
  } catch { /* fall through to the safe default */ }
  return 'right';
};

export const start = {
  summary: 'Dispatch a task: create or reuse a Herdr pane, start an agent, inject the contract',
  usage: 'cbds dispatch start --task <task_id> [--agent <kind>] [--pane <pane_id>]',
  flags: {
    task: { type: 'string', placeholder: 'task_id', describe: 'the task to dispatch' },
    agent: { type: 'string', describe: `agent kind: ${KNOWN_AGENT_KINDS.slice(0, 6).join('|')}|… (any kind your Herdr supports)` },
    pane: { type: 'string', placeholder: 'pane_id', describe: 'attach to an existing pane instead of splitting' },
    direction: { type: 'string', describe: 'right|down (default: chosen from pane geometry)' },
    cwd: { type: 'string', placeholder: 'path', describe: 'working directory for the worker' },
    name: { type: 'string', describe: 'agent name (default: derived from the task id)' },
    'retry-of': { type: 'string', placeholder: 'dispatch_id', describe: 'supersede a previous attempt' },
    focus: { type: 'boolean', default: false, describe: 'move the user’s focus to the worker' },
    'startup-timeout': { type: 'number', default: 60000, placeholder: 'ms', describe: 'agent startup timeout' },
    'prompt-timeout': { type: 'number', default: 120000, placeholder: 'ms', describe: 'preamble delivery timeout' },
    'max-depth': { type: 'number', default: 1, describe: 'nesting guard: how many generations may dispatch' },
    ratio: { type: 'number', describe: 'split ratio, 0..1' },
    model: { type: 'string', describe: `model for this worker (mapped for: ${launchKinds().join(', ')})` },
    effort: { type: 'string', describe: 'reasoning effort; requires --model' },
    'wait-ready': { type: 'number', default: 0, placeholder: 'ms', describe: 'if the agent starts blocked (e.g. a trust dialog), wait this long for a human to clear it' },
    trust: { type: 'boolean', describe: 'pre-trust --cwd for this agent first, so it cannot stall on a directory-trust dialog' },
    'no-agent': { type: 'boolean', describe: 'create the pane with cbds env but start no agent (bare-shell dispatch)' },
    'dry-run': { type: 'boolean', describe: 'print the preamble and plan without touching Herdr' },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const R = store.run(run.run_id);
    const taskId = resolveTaskId(store, run.run_id, requireFlag(ctx.flags, 'task', 'cbds dispatch start --task <task_id>'));
    let task = reconcileTaskReadiness(store, loadTask(store, run.run_id, taskId));

    /* ---- guards, before touching Herdr ---- */

    if (run.state !== 'open') throw conflict('run_closed', `run ${run.run_id} is closed`);

    const depth = Number.parseInt(process.env.CBDS_DEPTH ?? '0', 10) || 0;
    if (depth >= ctx.flags['max-depth']) {
      throw conflict('nested_depth_exceeded',
        `this pane is already a cbds worker at depth ${depth} (max ${ctx.flags['max-depth']})`,
        'complete the task yourself rather than routing around the guard, or raise --max-depth');
    }
    if (!depsSatisfied(store, task)) {
      throw conflict('deps_unsatisfied',
        `task ${task.task_id} has unmet dependencies: ${task.deps.join(', ')}`);
    }
    if (task.attempts >= task.max_attempts) {
      throw conflict('task_circuit_open',
        `task ${task.task_id} has used all ${task.max_attempts} attempts`,
        `raise it with \`cbds task update ${task.task_id} --max-attempts ${task.max_attempts + 1}\``);
    }
    if (['completed', 'cancelled'].includes(task.state)) {
      throw conflict('task_terminal', `task ${task.task_id} is ${task.state}`);
    }

    const retryOf = ctx.flags['retry-of']
      ? resolveDispatchId(store, run.run_id, ctx.flags['retry-of'])
      : null;

    if (task.state === 'dispatched' && task.live_dispatch_id && !retryOf) {
      throw conflict('already_dispatched',
        `task ${task.task_id} is live on dispatch ${task.live_dispatch_id}`,
        `wait for it, or supersede it with --retry-of ${task.live_dispatch_id}`);
    }

    /* ---- supersede the previous attempt, revoking its completion authority ---- */

    if (retryOf) {
      const old = loadDispatch(store, run.run_id, retryOf);
      if (old.task_id !== task.task_id) {
        throw usage(`dispatch ${retryOf} belongs to task ${old.task_id}, not ${task.task_id}`);
      }
      supersedeDispatch(store, old, 'superseded by retry');
    }
    for (const d of listDispatches(store, run.run_id)) {
      if (d.task_id === task.task_id && d.authority && d.state !== 'settled' && d.dispatch_id !== retryOf) {
        supersedeDispatch(store, d, 'superseded by a new dispatch');
      }
    }

    /* ---- the dispatch record exists BEFORE the pane, so its id can go into env ---- */

    const bareShell = Boolean(ctx.flags['no-agent']);
    const agentKind = bareShell ? null : (ctx.flags.agent ?? store.config?.default_agent ?? 'claude');
    if (agentKind) {
      const { kinds, source } = await agentKinds();
      if (!kinds.includes(agentKind)) {
        throw usage(`unknown agent kind "${agentKind}"`,
          `kinds supported by ${source === 'herdr' ? 'your Herdr' : 'cbds (Herdr unreachable)'}: ${kinds.join(', ')}`);
      }
    }
    if (bareShell && ctx.flags.agent) {
      throw usage('--no-agent and --agent are mutually exclusive');
    }
    const cwd = ctx.flags.cwd ?? process.cwd();
    const agentName = ctx.flags.name ?? agentNameForDispatch(task.task_id, task.attempts + 1);

    const dispatch = createDispatch(store, task, {
      pane_id: null, workspace_id: null, tab_id: null,
      agent_name: agentName, agent_kind: agentKind, cwd,
    }, { retryOf, preambleSha: null, supervised: !ctx.flags.pane });

    // The preamble is shaped for the worker it is going to: a bare shell must exit
    // after reporting (no prompt to reuse), an agent must idle and stay reusable.
    // The sub-dispatch section is omitted entirely unless nesting is actually
    // allowed — a worker told it "usually cannot" delegate still tries.
    const preamble = buildPreamble({
      run, task, dispatch,
      workerKind: bareShell ? 'bare-shell' : 'agent',
      canDispatchSubWorkers: depth + 1 < ctx.flags['max-depth'],
    });
    dispatch.preamble_sha256 = sha256(preamble);

    if (ctx.flags['dry-run']) {
      say(ctx, c.dim('── dry run: nothing was created ──'));
      say(ctx, preamble);
      say(ctx, c.dim(`\nwould split ${ctx.flags.direction ?? 'auto'} from ${callerPane().pane_id ?? 'the focused pane'} and start agent kind "${agentKind}"`));
      // A dry run must leave no trace, so the speculative record is withdrawn.
      supersedeDispatch(store, dispatch, 'dry run');
      return emit(ctx, { dry_run: true, preamble, preamble_sha256: dispatch.preamble_sha256, dispatch });
    }

    if (!insideHerdr() && !process.env.HERDR_SOCKET_PATH) {
      supersedeDispatch(store, dispatch, 'herdr unavailable');
      throw noHerdr('cbds dispatch start needs a running Herdr session',
        'run it from inside a Herdr pane, or use `--pane <id>` from a host with HERDR_SOCKET_PATH set');
    }

    /* ---- optionally pre-trust the target directory ---- */

    if (ctx.flags.trust && !bareShell) {
      // Opt-in only. A directory-trust dialog is the most common way a dispatched
      // worker never receives its task, and a fresh git worktree hits it every time.
      const { trust: trustCmd } = await import('./trust.mjs');
      await trustCmd.run({
        ...ctx, commandName: 'trust', json: false, quiet: true,
        flags: { agent: agentKind }, positional: [cwd],
      });
    }

    /* ---- place the worker ---- */

    let paneInfo;
    try {
      if (ctx.flags.pane) {
        const got = await paneGet(ctx.flags.pane);
        paneInfo = got?.pane ?? got;
        if (!paneInfo?.pane_id) throw noHerdr(`pane ${ctx.flags.pane} not found`);
      } else {
        const direction = ctx.flags.direction
          ? oneOf(ctx.flags.direction, ['right', 'down'], 'direction')
          : await chooseDirection(callerPane().pane_id);
        const env = workerEnv({ run, task, dispatch, stateDir: ctx.stateRoot, depth: depth + 1 });
        const res = await paneSplit({
          targetPaneId: callerPane().pane_id,
          direction, cwd, env,
          focus: ctx.flags.focus,
          ratio: ctx.flags.ratio ?? null,
        });
        paneInfo = res?.pane ?? res;
      }
    } catch (err) {
      supersedeDispatch(store, dispatch, `pane creation failed: ${err.code ?? 'error'}`);
      throw err;
    }

    dispatch.target = {
      ...dispatch.target,
      pane_id: paneInfo.pane_id,
      workspace_id: paneInfo.workspace_id ?? null,
      tab_id: paneInfo.tab_id ?? null,
    };
    saveDispatch(store, dispatch, { event: 'dispatch.pane_ready', pane_id: paneInfo.pane_id });

    /* ---- start the agent ---- */

    let startResult;
    let agentReady = true;
    if (bareShell) {
      // Bare-shell dispatch: the pane carries the full CBDS_* identity, so whoever
      // works in it (a human, a script, an agent started by hand) can still run
      // `cbds done`. Nothing is injected, so nothing can be misdelivered.
      agentReady = false;
    } else try {
      startResult = await agentStart({
        name: agentName, kind: agentKind, paneId: paneInfo.pane_id,
        timeoutMs: ctx.flags['startup-timeout'],
        args: buildAgentArgs({
          kind: agentKind,
          model: ctx.flags.model ?? null,
          effort: ctx.flags.effort ?? null,
          extra: ctx.passthrough ?? [],
        }),
      });
      if (startResult?._allowed) agentReady = false;
    } catch (err) {
      dispatch.state = 'abandoned';
      dispatch.authority = false;
      saveDispatch(store, dispatch, { event: 'dispatch.agent_start_failed', error: err.code });
      throw new CbdsError('agent_start_failed',
        `could not start ${agentKind} in ${paneInfo.pane_id}: ${err.message}`, {
          exit: EXIT.NO_HERDR,
          hint: `the pane exists; inspect it with \`herdr pane read ${paneInfo.pane_id}\` or close it`,
          details: { pane_id: paneInfo.pane_id, dispatch_id: dispatch.dispatch_id },
        });
    }

    /* ---- inject the contract ---- */

    let promptResult = null;
    let injected = !bareShell;

    /**
     * A dispatch is only live if the worker actually received the contract.
     *
     * Herdr refuses to prompt an agent sitting at an approval or question dialog
     * (agent_blocked) — a trust prompt on a new directory is the common case. If cbds
     * recorded that dispatch as live anyway, the coordinator would wait its full
     * timeout for a worker that was never told what to do: the exact silent hang cbds
     * exists to eliminate. So an undelivered contract fails loudly instead.
     */
    const undelivered = (reason, hint) => {
      dispatch.state = 'abandoned';
      dispatch.authority = false;
      saveDispatch(store, dispatch, { event: 'dispatch.contract_undelivered', reason });
      return new CbdsError('contract_undelivered',
        `the agent started in ${paneInfo.pane_id} but never received the task (${reason})`, {
          exit: EXIT.CONTRACT_UNDELIVERED,
          hint,
          details: {
            pane_id: paneInfo.pane_id, dispatch_id: dispatch.dispatch_id,
            task_id: task.task_id, reason,
          },
        });
    };

    if (bareShell) {
      // No agent to prompt. The contract is still written to disk and printed below.
    } else {
      // An agent parked on a startup dialog can be cleared by a human. Wait only if
      // the caller asked for it: defaulting to a silent wait would reintroduce the hang.
      if (!agentReady && ctx.flags['wait-ready'] > 0) {
        say(ctx, c.dim(`  agent is blocked at startup; waiting up to ${ctx.flags['wait-ready']}ms for it to clear…`));
        try {
          await agentWait(agentName, { until: ['idle', 'done'], timeoutMs: ctx.flags['wait-ready'] });
          const info = await agentGet(agentName);
          agentReady = (info?.agent ?? info)?.agent_status !== 'blocked';
        } catch { /* still blocked; the prompt attempt below decides */ }
      }

      try {
        promptResult = await agentPrompt({
          target: agentName, text: preamble,
          wait: false, timeoutMs: ctx.flags['prompt-timeout'],
        });
        if (promptResult?._allowed) injected = false;
      } catch (err) {
        throw undelivered(err.code ?? 'prompt_failed',
          `retry with --retry-of ${dispatch.dispatch_id} once the pane is usable`);
      }

      if (!injected) {
        const reason = promptResult._allowed;
        throw undelivered(reason, reason === 'agent_blocked'
          ? `the agent is sitting at a dialog (a directory-trust prompt is the usual cause). Pre-trust it with \`cbds trust "${cwd}" --agent ${agentKind}\`, or answer the dialog in pane ${paneInfo.pane_id} and pass --wait-ready 120000, then retry with --retry-of ${dispatch.dispatch_id}`
          : `inspect the pane with \`herdr agent read ${agentName}\`, then retry with --retry-of ${dispatch.dispatch_id}`);
      }
    }

    /* ---- commit ---- */

    dispatch.state = 'dispatched';
    saveDispatch(store, dispatch, { event: 'dispatch.dispatched', pane_id: paneInfo.pane_id, agent: agentKind });

    task.attempts += 1;
    task.state = 'dispatched';
    task.live_dispatch_id = dispatch.dispatch_id;
    task.dispatch_ids = [...new Set([...(task.dispatch_ids ?? []), dispatch.dispatch_id])];
    saveTask(store, task, { event: 'task.dispatched', dispatch_id: dispatch.dispatch_id });

    await paintPane(paneInfo.pane_id, {
      title: `cbds ${truncate(task.title, 24)}`,
      tokens: { cbds: task.task_id.slice(-6), attempt: String(dispatch.attempt) },
      stateLabels: { working: `cbds working · ${truncate(task.title, 18)}`, idle: 'cbds awaiting report' },
    });

    appendEvent(R.events, {
      event: 'dispatch.started', dispatch_id: dispatch.dispatch_id, task_id: task.task_id,
      pane_id: paneInfo.pane_id, agent: agentKind ?? 'shell', agent_ready: agentReady, injected,
    });

    say(ctx, `${c.green('dispatched')}  ${c.bold(task.task_id)} ${c.dim('->')} ${c.bold(paneInfo.pane_id)}`);
    say(ctx, kv([
      ['dispatch', dispatch.dispatch_id],
      ['agent', agentKind ? `${agentKind} (${agentName})` : 'none (bare shell)'],
      ['pane', paneInfo.pane_id],
      ['attempt', `${dispatch.attempt} of ${task.max_attempts}`],
      ['cwd', cwd],
      ['launch', [ctx.flags.model && `model=${ctx.flags.model}`, ctx.flags.effort && `effort=${ctx.flags.effort}`,
        (ctx.passthrough ?? []).length && `args=${ctx.passthrough.join(' ')}`].filter(Boolean).join('  ') || null],
      ['preamble', `sha256:${dispatch.preamble_sha256.slice(0, 16)}`],
    ]));
    if (bareShell) {
      say(ctx, c.dim('  bare shell: no agent started, no prompt injected.'));
      say(ctx, c.dim(`  the pane carries CBDS_* env, so \`cbds done\` works there. Contract:`));
      say(ctx, c.dim(`    cbds dispatch show ${dispatch.dispatch_id} --preamble`));
    } else if (!agentReady) say(ctx, c.dim('  note: the agent was briefly not-ready at startup, but the contract was delivered'));
    say(ctx, c.dim(`\n  next: cbds wait --task ${task.task_id} --timeout 900000`));

    return emit(ctx, {
      dispatch, task,
      pane: { pane_id: paneInfo.pane_id, workspace_id: paneInfo.workspace_id ?? null, tab_id: paneInfo.tab_id ?? null },
      agent: { name: agentKind ? agentName : null, kind: agentKind, ready: agentReady, bare_shell: bareShell },
      injected,
      preamble_sha256: dispatch.preamble_sha256,
    });
  },
};

export const list = {
  summary: 'List dispatches',
  usage: 'cbds dispatch list [--task <id>] [--state <s>]',
  flags: {
    task: { type: 'string', placeholder: 'task_id', describe: 'filter by task' },
    state: { type: 'string', describe: `filter: ${DISPATCH_STATES.join('|')}` },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    let dispatches = listDispatches(store, run.run_id);
    if (ctx.flags.task) {
      const id = resolveTaskId(store, run.run_id, ctx.flags.task);
      dispatches = dispatches.filter((d) => d.task_id === id);
    }
    if (ctx.flags.state) {
      oneOf(ctx.flags.state, DISPATCH_STATES, 'state');
      dispatches = dispatches.filter((d) => d.state === ctx.flags.state);
    }
    dispatches.sort((a, b) => b.started_at.localeCompare(a.started_at));

    say(ctx, table(dispatches, [
      { header: 'DISPATCH', get: (d) => c.bold(d.dispatch_id) },
      { header: 'TASK', get: (d) => d.task_id },
      { header: 'STATE', get: (d) => paintState(d.state) },
      { header: 'AUTH', get: (d) => (d.authority ? c.green('yes') : c.dim('no')) },
      { header: 'PANE', get: (d) => d.target.pane_id ?? c.dim('—') },
      { header: 'AGENT', get: (d) => d.target.agent_kind },
      { header: 'OUTCOME', get: (d) => (d.outcome ? paintState(d.outcome) : c.dim('—')) },
      { header: 'STARTED', get: (d) => relTime(d.started_at) },
    ]));
    return emit(ctx, { run_id: run.run_id, count: dispatches.length, dispatches });
  },
};

export const show = {
  summary: 'Show one dispatch, optionally the exact preamble its worker received',
  usage: 'cbds dispatch show <dispatch_id> [--preamble] [--hints]',
  flags: {
    preamble: { type: 'boolean', describe: 'reprint the contract verbatim' },
    hints: { type: 'boolean', describe: 'show the advisory Herdr event log' },
  },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const id = resolveDispatchId(store, run.run_id, requireFlag({ id: ctx.positional[0] }, 'id', 'cbds dispatch show <dispatch_id>'));
    const dispatch = loadDispatch(store, run.run_id, id);
    const task = loadTask(store, run.run_id, dispatch.task_id);

    say(ctx, `${c.bold(dispatch.dispatch_id)}  ${paintState(dispatch.state)}${dispatch.authority ? '' : c.dim('  (no authority)')}`);
    say(ctx, kv([
      ['task', `${dispatch.task_id}  ${truncate(task.title, 40)}`],
      ['attempt', `${dispatch.attempt} of ${task.max_attempts}`],
      ['retry of', dispatch.retry_of],
      ['pane', dispatch.target.pane_id],
      ['agent', `${dispatch.target.agent_kind} (${dispatch.target.agent_name})`],
      ['supervised', dispatch.target.supervised ? 'yes' : 'no (operator-owned pane)'],
      ['cwd', dispatch.target.cwd],
      ['outcome', dispatch.outcome ? paintState(dispatch.outcome) : null],
      ['report', dispatch.report_id],
      ['started', relTime(dispatch.started_at)],
      ['settled', dispatch.settled_at ? relTime(dispatch.settled_at) : null],
      ['released', dispatch.released ? 'yes' : (dispatch.retained ? 'retained' : 'no')],
      ['preamble', dispatch.preamble_sha256 ? `sha256:${dispatch.preamble_sha256.slice(0, 16)}` : null],
    ]));

    let preamble = null;
    if (ctx.flags.preamble) {
      preamble = buildPreamble({ run, task, dispatch });
      const matches = sha256(preamble) === dispatch.preamble_sha256;
      say(ctx, `\n${c.dim('  preamble')} ${matches ? c.green('(hash matches)') : c.red('(HASH MISMATCH — task spec changed since dispatch)')}`);
      say(ctx, preamble);
    }
    if (ctx.flags.hints && dispatch.hints?.length) {
      say(ctx, `\n${c.dim('  hints (advisory only — never authoritative)')}`);
      say(ctx, table(dispatch.hints, [
        { header: 'AT', get: (h) => relTime(h.at) },
        { header: 'KIND', get: (h) => h.kind },
        { header: 'VALUE', get: (h) => String(h.value) },
      ]));
    }
    return emit(ctx, { ...dispatch, task_title: task.title, ...(preamble ? { preamble } : {}) });
  },
};

export const cancel = {
  summary: 'Revoke a dispatch’s completion authority without settling its task',
  usage: 'cbds dispatch cancel <dispatch_id>',
  flags: { reason: { type: 'string', describe: 'why' } },
  async run(ctx) {
    const run = resolveRun(ctx);
    const store = ctx.store();
    const id = resolveDispatchId(store, run.run_id, requireFlag({ id: ctx.positional[0] }, 'id', 'cbds dispatch cancel <dispatch_id>'));
    const dispatch = loadDispatch(store, run.run_id, id);
    if (dispatch.state === 'settled') {
      throw conflict('already_settled', `dispatch ${id} already settled with outcome ${dispatch.outcome}`);
    }
    supersedeDispatch(store, dispatch, ctx.flags.reason ?? 'cancelled by operator');

    const task = loadTask(store, run.run_id, dispatch.task_id);
    if (task.live_dispatch_id === dispatch.dispatch_id) {
      task.live_dispatch_id = null;
      task.state = task.state === 'dispatched' ? 'ready' : task.state;
      saveTask(store, task, { event: 'task.dispatch_cancelled', dispatch_id: dispatch.dispatch_id });
    }
    say(ctx, `${c.yellow('dispatch cancelled')}  ${c.bold(id)}  ${c.dim('authority revoked')}`);
    say(ctx, c.dim(`  task ${task.task_id} is now ${task.state}; its pane is still running`));
    return emit(ctx, { dispatch, task });
  },
};
