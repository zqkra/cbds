const ESC = '[';
const RESET = `${ESC}0m`;

const useColor = () =>
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (code) => (text) => (useColor() ? `${ESC}${code}m${text}${RESET}` : String(text));

export const c = {
  dim: wrap('2'), bold: wrap('1'), red: wrap('31'), green: wrap('32'),
  yellow: wrap('33'), blue: wrap('34'), magenta: wrap('35'), cyan: wrap('36'),
};

const ANSI_RE = /\[[0-9;]*m/g;
const visibleWidth = (text) => String(text ?? '').replace(ANSI_RE, '').length;

export const STATE_COLOR = {
  pending: c.dim, ready: c.cyan, dispatched: c.yellow, completed: c.green,
  failed: c.red, blocked: c.magenta, cancelled: c.dim,
  starting: c.dim, settled: c.green, superseded: c.dim, abandoned: c.red,
  succeeded: c.green,
};

export const paintState = (state) => (STATE_COLOR[state] ?? ((s) => String(s)))(state);

/**
 * Stable machine envelope. The shape is API: `ok`, `command`, and exactly one of
 * `data` or `error`. Orchestrators branch on `ok` and read `error.code`.
 */
export const emit = (ctx, data) => {
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, command: ctx.commandName, data }, null, 2)}\n`);
  }
  return data;
};

export const emitError = (ctx, err) => {
  const body = typeof err?.toJSON === 'function'
    ? err.toJSON()
    : { code: 'internal', message: String(err?.message ?? err), exit: 1 };
  if (ctx?.json) {
    process.stdout.write(`${JSON.stringify({ ok: false, command: ctx.commandName ?? null, error: body }, null, 2)}\n`);
  } else {
    process.stderr.write(`${c.red('cbds:')} ${c.bold(body.code)} — ${body.message}\n`);
    if (body.hint) process.stderr.write(`${c.dim(`  hint: ${body.hint}`)}\n`);
  }
};

export const say = (ctx, text = '') => {
  if (!ctx.json && !ctx.quiet) process.stdout.write(`${text}\n`);
};

/** Left-aligned column table with a dim header. Used by every `list` command. */
export const table = (rows, columns) => {
  if (!rows.length) return c.dim('  (none)');
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((r) => visibleWidth(col.get(r)))));
  const line = (cells) => `  ${cells.map((cell, i) => {
    const pad = Math.max(0, widths[i] - visibleWidth(cell));
    return `${String(cell ?? '')}${' '.repeat(pad)}`;
  }).join('  ').trimEnd()}`;
  return [
    c.dim(line(columns.map((col) => col.header))),
    ...rows.map((r) => line(columns.map((col) => col.get(r)))),
  ].join('\n');
};

export const kv = (pairs) =>
  pairs.filter(([, v]) => v !== undefined)
    .map(([k, v]) => `  ${c.dim(`${k}:`.padEnd(16))} ${v === null || v === '' ? c.dim('—') : v}`)
    .join('\n');

export const relTime = (iso) => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export const duration = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

export const truncate = (text, max = 60) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};
