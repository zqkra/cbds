import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The canonical skill text shipped with this cbds. */
export const SKILL_SOURCE = path.resolve(HERE, '..', '..', 'skills', 'cbds', 'SKILL.md');

/**
 * Where each agent CLI loads skills from, verified on a real machine rather than
 * guessed. `universal` is the store `npx skills` uses; agents do not read it directly,
 * so it never counts as "installed for <kind>" — it is only a convenience copy.
 */
export const SKILL_HOMES = {
  claude: ['.claude', 'skills'],
  codex: ['.codex', 'skills'],
  opencode: ['.config', 'opencode', 'skills'],
  pi: ['.pi', 'agent', 'skills'],
  gemini: ['.gemini', 'skills'],
  grok: ['.grok', 'skills'],
};
export const UNIVERSAL_HOME = ['.agents', 'skills'];

export const skillKinds = () => Object.keys(SKILL_HOMES);

export const skillDirFor = (kind, home = os.homedir()) => {
  const parts = kind === 'universal' ? UNIVERSAL_HOME : SKILL_HOMES[kind];
  return parts ? path.join(home, ...parts, 'cbds') : null;
};

export const skillFileFor = (kind, home) => {
  const dir = skillDirFor(kind, home);
  return dir ? path.join(dir, 'SKILL.md') : null;
};

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

export const shippedSkill = () => {
  const text = fs.readFileSync(SKILL_SOURCE, 'utf8');
  return { text, sha: sha(text) };
};

/**
 * Is the cbds skill installed for this agent kind, and is it current?
 *
 * This is the switch that lets a dispatch go bare: a worker that has the skill already
 * knows `cbds done`, `whoami`, `ask` and the rules, so re-teaching them on every
 * dispatch is pure token waste. An unknown kind reports `unknown`, and the caller
 * treats that as "not installed" — guessing that a worker knows the protocol is how
 * you get a silent non-report.
 */
export const skillStatus = (kind, home = os.homedir()) => {
  const file = skillFileFor(kind, home);
  if (!file) return { kind, status: 'unknown', path: null };
  let installed = null;
  try { installed = fs.readFileSync(file, 'utf8'); } catch { return { kind, status: 'missing', path: file }; }
  const current = shippedSkill().sha === sha(installed);
  return { kind, status: current ? 'installed' : 'outdated', path: file };
};

export const skillInstalledFor = (kind, home) => skillStatus(kind, home).status === 'installed';

export const installSkill = (kind, home = os.homedir()) => {
  const file = skillFileFor(kind, home);
  if (!file) return { kind, status: 'unknown', path: null };
  const before = skillStatus(kind, home).status;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, shippedSkill().text);
  return { kind, status: before === 'installed' ? 'already_current' : (before === 'missing' ? 'installed' : 'updated'), path: file };
};
