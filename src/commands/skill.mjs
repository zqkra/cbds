import { csv } from '../core/args.mjs';
import { usage } from '../core/errors.mjs';
import { emit, say, table, c } from '../core/output.mjs';
import { skillKinds, skillStatus, installSkill } from '../core/skills.mjs';

/**
 * Put the cbds skill where each agent CLI loads it from.
 *
 * This is what makes dispatches cheap. Herdr's own mesh works the same way: the
 * receiver already holds the protocol, so a message is just the message. Once the
 * skill is installed for an agent kind, `dispatch start` goes bare for it — task text
 * plus one anchor line — instead of re-teaching the contract every time.
 */
const paint = {
  installed: c.green('installed'), updated: c.green('updated'), already_current: c.dim('current'),
  outdated: c.yellow('outdated'), missing: c.red('missing'), unknown: c.dim('no known skill dir'),
};

const targets = (flags) => {
  const wanted = csv(flags.agent);
  for (const k of wanted) {
    if (k !== 'universal' && !skillKinds().includes(k)) {
      throw usage(`no known skill directory for "${k}"`,
        `known: ${skillKinds().join(', ')}, universal. For other agents: npx skills add zqkra/cbds --skill cbds -g`);
    }
  }
  // `universal` (~/.agents/skills) is opt-in, not a default. Agents that have their
  // own skill directory read BOTH, and installing to each produces a duplicate-skill
  // warning on every start — pi prints a "cbds collision" banner. Cover the specific
  // dirs; add `--agent universal` deliberately for agents that only read the shared one.
  return wanted.length ? wanted : skillKinds();
};

export const status = {
  summary: 'Which agents have the cbds skill (and therefore get bare dispatches)',
  usage: 'cbds skill status [--agent claude,codex]',
  flags: { agent: { type: 'string', placeholder: 'csv', describe: 'restrict to these kinds' } },
  async run(ctx) {
    const rows = targets(ctx.flags).map((k) => skillStatus(k));
    say(ctx, table(rows, [
      { header: 'AGENT', get: (r) => r.kind },
      { header: 'SKILL', get: (r) => paint[r.status] ?? r.status },
      { header: 'PATH', get: (r) => c.dim(r.path ?? '—') },
    ]));
    const missing = rows.filter((r) => ['missing', 'outdated'].includes(r.status) && r.kind !== 'universal');
    if (missing.length) say(ctx, c.dim(`\n  install with: cbds skill install --agent ${missing.map((r) => r.kind).join(',')}`));
    return emit(ctx, { agents: rows });
  },
};

export const install = {
  summary: 'Install the cbds skill into each agent’s skill directory',
  usage: 'cbds skill install [--agent claude,codex,pi]',
  flags: { agent: { type: 'string', placeholder: 'csv', describe: 'which kinds (default: all known + universal)' } },
  async run(ctx) {
    const rows = targets(ctx.flags).map((k) => installSkill(k));
    say(ctx, table(rows, [
      { header: 'AGENT', get: (r) => r.kind },
      { header: 'RESULT', get: (r) => paint[r.status] ?? r.status },
      { header: 'PATH', get: (r) => c.dim(r.path ?? '—') },
    ]));
    say(ctx, c.dim('\n  agents load skills at session start: a worker already running will not see this until it restarts.'));
    return emit(ctx, { agents: rows });
  },
};
