import { usage } from './errors.mjs';

/**
 * Minimal, strict argv parser. Strict on purpose: an unknown flag is a usage error,
 * never a silently ignored typo. An orchestrating agent that mistypes `--timout`
 * must find out immediately rather than block forever on a default.
 */
export const parseArgs = (argv, spec = {}) => {
  const flags = {};
  const positional = [];
  // Everything after a bare `--` is passthrough, kept separate from positionals so a
  // command can forward native arguments to another program without ambiguity.
  const passthrough = [];
  const known = new Map();

  for (const [name, def] of Object.entries(spec)) {
    known.set(`--${name}`, { name, ...def });
    if (def.alias) known.set(`-${def.alias}`, { name, ...def });
    if (def.type === 'boolean' && def.negatable !== false) {
      known.set(`--no-${name}`, { name, ...def, negated: true });
    }
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { passthrough.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { positional.push(arg); continue; }

    let key = arg;
    let inline = null;
    const eq = arg.indexOf('=');
    if (eq > 0) { key = arg.slice(0, eq); inline = arg.slice(eq + 1); }

    const def = known.get(key);
    if (!def) throw usage(`unknown option: ${key}`, 'run with --help to see valid options');

    if (def.type === 'boolean') {
      flags[def.name] = def.negated ? false : (inline === null ? true : inline !== 'false');
      continue;
    }

    const value = inline !== null ? inline : argv[++i];
    if (value === undefined) throw usage(`option ${key} needs a value`);

    if (def.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw usage(`option ${key} needs a number, got "${value}"`);
      flags[def.name] = n;
    } else if (def.multiple) {
      flags[def.name] = [...(flags[def.name] ?? []), value];
    } else {
      flags[def.name] = value;
    }
  }

  for (const [name, def] of Object.entries(spec)) {
    if (flags[name] === undefined && def.default !== undefined) flags[name] = def.default;
  }

  return { flags, positional, passthrough };
};

export const csv = (value) => {
  if (value == null) return [];
  const parts = Array.isArray(value) ? value : [value];
  return parts.flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
};

export const requireFlag = (flags, name, hint) => {
  const v = flags[name];
  if (v === undefined || v === null || v === '') throw usage(`--${name} is required`, hint);
  return v;
};

export const oneOf = (value, allowed, name) => {
  if (!allowed.includes(value)) {
    throw usage(`--${name} must be one of: ${allowed.join(', ')} (got "${value}")`);
  }
  return value;
};

/** Render a flag spec as aligned help text. */
export const renderFlags = (spec) => {
  const entries = Object.entries(spec).filter(([, d]) => !d.hidden);
  if (!entries.length) return '';
  const left = entries.map(([name, d]) => {
    const alias = d.alias ? `-${d.alias}, ` : '';
    const arg = d.type === 'boolean' ? '' : ` <${d.placeholder ?? d.type ?? 'value'}>`;
    return `  ${alias}--${name}${arg}`;
  });
  const width = Math.max(...left.map((l) => l.length));
  return entries.map(([, d], i) => {
    const def = d.default !== undefined && d.default !== false ? ` (default: ${d.default})` : '';
    return `${left[i].padEnd(width)}  ${d.describe ?? ''}${def}`;
  }).join('\n');
};
