import { randomBytes } from 'node:crypto';

// Crockford base32 minus ambiguous glyphs: ids get read aloud and retyped by humans
// and pasted by agents, so I/L/O/U are excluded on purpose.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const encode = (value, length) => {
  let n = BigInt(value);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out = ALPHABET[Number(n % 32n)] + out;
    n /= 32n;
  }
  return out;
};

/**
 * Time-prefixed so that a lexical sort of ids is a chronological sort. That keeps
 * directory listings meaningful without opening every file.
 */
export const newId = (prefix, now = Date.now()) => {
  const time = encode(now, 8);
  const rand = Array.from(randomBytes(5))
    .map((b) => ALPHABET[b % 32])
    .join('');
  return `${prefix}_${(time + rand).toLowerCase()}`;
};

export const newRunId = () => newId('run');
export const newTaskId = () => newId('tsk');
export const newDispatchId = () => newId('dsp');
export const newReportId = () => newId('rpt');
export const newGateId = () => newId('gat');

const ID_RE = /^(run|tsk|dsp|rpt|gat)_[0-9a-hjkmnp-tv-z]{13}$/;
export const isId = (value, prefix) =>
  typeof value === 'string' && ID_RE.test(value) && (!prefix || value.startsWith(`${prefix}_`));

/**
 * Agent name for a dispatch. Must match Herdr's rule: [a-z][a-z0-9_-]{0,31}.
 *
 * Derived from the DISPATCH id, never from the attempt number. Attempt numbers are
 * not unique in practice: `task.attempts` only increments once a dispatch commits, so
 * a launch that failed leaves it unchanged and the retry would ask Herdr for a name
 * the failed attempt's pane is still holding — which fails with agent_start_failed and
 * looks like a mystery. A dispatch id is unique by construction, so this cannot recur.
 */
export const agentNameForDispatch = (dispatchId) =>
  `cbds-${dispatchId.replace(/^dsp_/, '')}`.slice(0, 32);
