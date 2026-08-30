import { execFile } from 'node:child_process';
import { CbdsError, EXIT, noHerdr } from '../core/errors.mjs';

/** Herdr prescribes HERDR_BIN_PATH for portable invocation from plugins. */
export const herdrBin = () => process.env.HERDR_BIN_PATH || 'herdr';

export const insideHerdr = () =>
  process.env.HERDR_ENV === '1' && Boolean(process.env.HERDR_SOCKET_PATH);

export const callerPane = () => ({
  pane_id: process.env.HERDR_PANE_ID ?? null,
  tab_id: process.env.HERDR_TAB_ID ?? null,
  workspace_id: process.env.HERDR_WORKSPACE_ID ?? null,
});

const runRaw = (args, { timeoutMs = 30_000, maxBuffer = 8 * 1024 * 1024 } = {}) =>
  new Promise((resolve) => {
    execFile(herdrBin(), args, { timeout: timeoutMs, maxBuffer, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ error, stdout: stdout ?? '', stderr: stderr ?? '' }));
  });

const parseMaybeJson = (text) => {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  // Herdr prints one JSON document; be tolerant of a leading banner line.
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(trimmed.slice(start)); } catch { return null; }
};

/**
 * Invoke the Herdr CLI and return `.result`.
 *
 * Every Herdr failure is mapped onto a cbds error with a real code, so callers can
 * branch on `err.details.herdr_code` instead of matching strings.
 */
export const herdr = async (args, { timeoutMs = 30_000, allow = [] } = {}) => {
  const { error, stdout, stderr } = await runRaw(args, { timeoutMs });
  const payload = parseMaybeJson(stdout) ?? parseMaybeJson(stderr);

  if (error && error.code === 'ENOENT') {
    throw noHerdr(`herdr binary not found (tried "${herdrBin()}")`,
      'install Herdr, or set HERDR_BIN_PATH');
  }
  if (error && error.killed) {
    throw new CbdsError('herdr_timeout', `herdr ${args[0]} ${args[1] ?? ''} timed out after ${timeoutMs}ms`, {
      exit: EXIT.NO_HERDR,
    });
  }

  if (payload?.error) {
    const code = payload.error.code ?? 'herdr_error';
    if (allow.includes(code)) return { _allowed: code, ...payload };
    throw new CbdsError(`herdr:${code}`, payload.error.message ?? 'herdr call failed', {
      exit: EXIT.NO_HERDR,
      details: { herdr_code: code, args },
    });
  }
  if (error) {
    const msg = (stderr || stdout || error.message).trim().split('\n').slice(0, 3).join(' ');
    throw new CbdsError('herdr_failed', `herdr ${args.join(' ')} failed: ${msg}`, {
      exit: error.code === 2 ? EXIT.USAGE : EXIT.NO_HERDR,
      details: { args, exit_code: error.code ?? null },
    });
  }
  if (!payload) {
    throw new CbdsError('herdr_unparsable', `could not parse herdr output for: ${args.join(' ')}`, {
      exit: EXIT.NO_HERDR, details: { stdout: stdout.slice(0, 400) },
    });
  }
  return payload.result ?? payload;
};

/** Best-effort variant for cosmetic calls (sidebar labels) that must never fail a command. */
export const herdrSoft = async (args, opts) => {
  try { return await herdr(args, opts); } catch { return null; }
};

/**
 * Raw-text variant. `pane read` and `agent read` print terminal content directly
 * rather than a JSON envelope, so they must not go through the JSON parser.
 */
export const herdrText = async (args, { timeoutMs = 45_000 } = {}) => {
  const { error, stdout, stderr } = await runRaw(args, { timeoutMs });
  if (error && error.code === 'ENOENT') {
    throw noHerdr(`herdr binary not found (tried "${herdrBin()}")`, 'install Herdr, or set HERDR_BIN_PATH');
  }
  const asJson = parseMaybeJson(stderr) ?? parseMaybeJson(stdout);
  if (asJson?.error) {
    throw new CbdsError(`herdr:${asJson.error.code ?? 'error'}`, asJson.error.message ?? 'herdr read failed', {
      exit: EXIT.NO_HERDR, details: { args },
    });
  }
  if (error) {
    throw new CbdsError('herdr_failed', `herdr ${args.join(' ')} failed`, {
      exit: EXIT.NO_HERDR, details: { args, exit_code: error.code ?? null },
    });
  }
  return stdout;
};

/* ------------------------------------------------------------- operations -- */

export const paneLayout = (paneId) =>
  herdr(paneId ? ['pane', 'layout', '--pane', paneId] : ['pane', 'layout', '--current']);

export const paneGet = (paneId) => herdr(['pane', 'get', paneId]);

export const paneList = (workspaceId) =>
  herdr(workspaceId ? ['pane', 'list', '--workspace', workspaceId] : ['pane', 'list']);

export const paneClose = (paneId) => herdr(['pane', 'close', paneId], { allow: ['pane_not_found'] });

export const paneRead = (paneId, { source = 'recent-unwrapped', lines = 2000 } = {}) =>
  herdrText(['pane', 'read', paneId, '--source', source, '--lines', String(lines)]);

export const paneSplit = async ({ targetPaneId = null, direction = 'right', cwd = null, env = {}, focus = false, ratio = null }) => {
  const args = ['pane', 'split'];
  if (targetPaneId) args.push('--pane', targetPaneId); else args.push('--current');
  args.push('--direction', direction);
  if (ratio != null) args.push('--ratio', String(ratio));
  if (cwd) args.push('--cwd', cwd);
  for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
  args.push(focus ? '--focus' : '--no-focus');
  return herdr(args, { timeoutMs: 30_000 });
};

/**
 * The agent kinds this Herdr build supports.
 *
 * Asked of Herdr rather than hardcoded, so a kind added by a Herdr upgrade works
 * immediately instead of being rejected by a stale list in cbds. The static list is
 * only a fallback for when Herdr cannot be reached.
 */
export const KNOWN_AGENT_KINDS = [
  'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp',
  'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok',
  'hermes', 'kilo', 'qodercli', 'qwen', 'maki',
];

let kindsCache = null;
export const agentKinds = async () => {
  if (kindsCache) return kindsCache;
  // `herdr agent` prints its group listing to STDERR and exits 2 (it is a usage
  // message, not a failure), so this reads both streams and ignores the exit code.
  try {
    const { stdout, stderr } = await runRaw(['agent'], { timeoutMs: 8000 });
    const line = `${stdout}\n${stderr}`.match(/^\s*kinds:\s*(.+)$/m)?.[1];
    const kinds = line?.split('|').map((k) => k.trim()).filter(Boolean) ?? [];
    if (kinds.length) { kindsCache = { kinds, source: 'herdr' }; return kindsCache; }
  } catch { /* fall back below */ }
  kindsCache = { kinds: KNOWN_AGENT_KINDS, source: 'builtin' };
  return kindsCache;
};

export const agentStart = ({ name, kind, paneId, timeoutMs = 60_000, args: agentArgs = [] }) => {
  const args = ['agent', 'start', name, '--kind', kind, '--pane', paneId, '--timeout', String(timeoutMs)];
  if (agentArgs.length) args.push('--', ...agentArgs);
  // agent_not_ready is a real, documented outcome: the agent exists but is blocked at
  // startup. That is recoverable, so it is surfaced rather than thrown.
  return herdr(args, { timeoutMs: timeoutMs + 15_000, allow: ['agent_not_ready', 'agent_blocked'] });
};

export const agentPrompt = ({ target, text, wait = false, timeoutMs = 120_000 }) => {
  const args = ['agent', 'prompt', target, text];
  if (wait) args.push('--wait', '--timeout', String(timeoutMs));
  return herdr(args, {
    timeoutMs: (wait ? timeoutMs : 30_000) + 15_000,
    allow: ['agent_blocked', 'agent_prompt_stalled', 'agent_wait_timeout'],
  });
};

export const agentGet = (target) => herdr(['agent', 'get', target], { allow: ['agent_not_found'] });

/** Block until the agent settles into one of `until`. Used to let a human clear a startup dialog. */
export const agentWait = (target, { until = ['idle', 'done'], timeoutMs = 60_000 } = {}) => {
  const args = ['agent', 'wait', target, '--timeout', String(timeoutMs)];
  for (const state of until) args.push('--until', state);
  return herdr(args, {
    timeoutMs: timeoutMs + 15_000,
    allow: ['agent_wait_timeout', 'agent_not_found', 'agent_blocked'],
  });
};

export const agentList = () => herdr(['agent', 'list']);

export const agentRead = (target, { source = 'recent-unwrapped', lines = 2000 } = {}) =>
  herdrText(['agent', 'read', target, '--source', source, '--lines', String(lines)]);

/**
 * Paint cbds state onto the pane so it shows up in Herdr's native sidebar.
 * Purely cosmetic: every call goes through herdrSoft and can fail silently.
 */
export const paintPane = (paneId, { tokens = {}, stateLabels = {}, title = null, ttlMs = null }) => {
  const args = ['pane', 'report-metadata', paneId, '--source', 'cbds'];
  if (title) args.push('--title', title);
  for (const [k, v] of Object.entries(tokens)) args.push('--token', `${k}=${v}`);
  for (const [k, v] of Object.entries(stateLabels)) args.push('--state-label', `${k}=${v}`);
  if (ttlMs) args.push('--ttl-ms', String(ttlMs));
  return herdrSoft(args, { timeoutMs: 10_000 });
};

export const clearPanePaint = (paneId) =>
  herdrSoft(['pane', 'report-metadata', paneId, '--source', 'cbds', '--clear-state-labels', '--clear-title'],
    { timeoutMs: 10_000 });

/** Whether a pane still exists. Used to turn a close/exit hint into a fact. */
export const paneAlive = async (paneId) => {
  try {
    const res = await paneGet(paneId);
    if (res?._allowed) return false;
    return Boolean(res);
  } catch (err) {
    if (String(err.code).includes('not_found')) return false;
    throw err;
  }
};
