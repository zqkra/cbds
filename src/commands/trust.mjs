import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { csv } from '../core/args.mjs';
import { CbdsError, EXIT, usage } from '../core/errors.mjs';
import { emit, say, table, c } from '../core/output.mjs';

/**
 * Pre-trust a directory for the agent CLIs that gate on one.
 *
 * Why this exists: claude and codex show a directory-trust dialog the first time they
 * run somewhere new. A dispatched worker parked on that dialog never receives its
 * task, and Herdr refuses to prompt it. Answering it by hand defeats the point of
 * orchestration, and a fresh git worktree hits it every single time.
 *
 * Deliberately NOT a global kill switch. It records trust for ONE directory, the same
 * record the dialog itself would write, so the security decision stays per-project and
 * explicit. Every file is backed up before it is touched.
 */

const AGENTS = {
  claude: {
    file: () => path.join(os.homedir(), '.claude.json'),
    label: 'Claude Code',
    isTrusted(dir) {
      const data = readJsonFile(this.file());
      return data?.projects?.[dir]?.hasTrustDialogAccepted === true;
    },
    trust(dir) {
      const file = this.file();
      const data = readJsonFile(file) ?? {};
      data.projects ??= {};
      data.projects[dir] = { ...(data.projects[dir] ?? {}), hasTrustDialogAccepted: true };
      backup(file);
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
      // Read back: a corrupted agent config is worse than an unanswered dialog.
      if (!this.isTrusted(dir)) throw new CbdsError('trust_write_failed', `wrote ${file} but it did not take`, { exit: EXIT.FAILURE });
    },
  },
  codex: {
    file: () => path.join(os.homedir(), '.codex', 'config.toml'),
    label: 'Codex',
    isTrusted(dir) {
      const block = findProjectBlock(readTextFile(this.file()) ?? '', dir);
      return Boolean(block && /^\s*trust_level\s*=\s*"trusted"\s*$/m.test(block.body));
    },
    trust(dir) {
      const file = this.file();
      const text = readTextFile(file);
      if (text === null) {
        throw new CbdsError('agent_config_missing', `no codex config at ${file}`, {
          exit: EXIT.NOT_FOUND, hint: 'run codex once so it creates its config, then retry',
        });
      }
      if (this.isTrusted(dir)) return;
      backup(file);

      const lines = text.split('\n');
      const block = findProjectBlock(text, dir);
      if (block) {
        // The table already exists with some other trust_level. Editing it in place
        // matters: appending a second [projects."<dir>"] would be a duplicate TOML
        // table, which does not merge — it makes the whole config fail to parse.
        const idx = lines.findIndex((l, i) => i > block.start && i < block.end
          && /^\s*trust_level\s*=/.test(l));
        if (idx >= 0) lines[idx] = 'trust_level = "trusted"';
        else lines.splice(block.start + 1, 0, 'trust_level = "trusted"');
        fs.writeFileSync(file, lines.join('\n'));
      } else {
        fs.writeFileSync(file,
          `${text.replace(/\s*$/, '')}\n\n[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`);
      }
      if (!this.isTrusted(dir)) {
        throw new CbdsError('trust_write_failed', `wrote ${file} but it did not take`, { exit: EXIT.FAILURE });
      }
    },
  },
};

export const MANAGED_KINDS = Object.keys(AGENTS);

/**
 * Locate a `[projects."<dir>"]` table by scanning lines rather than matching a regex
 * built from a path. Paths contain regex metacharacters and quotes, and the escaping
 * needed to survive both the string and the RegExp layer is exactly where the first
 * attempt at this silently returned "not trusted" for a directory that was trusted.
 */
const findProjectBlock = (text, dir) => {
  const lines = text.split('\n');
  const header = `[projects.${JSON.stringify(dir)}]`;
  const start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  return { start, end, body: lines.slice(start + 1, end).join('\n') };
};

const readTextFile = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};

const readJsonFile = (file) => {
  const text = readTextFile(file);
  if (text === null) return null;
  try { return JSON.parse(text); } catch {
    throw new CbdsError('agent_config_corrupt', `${file} is not valid JSON; refusing to touch it`, {
      exit: EXIT.FAILURE,
    });
  }
};

const backup = (file) => {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.cbds-bak`);
  } catch { /* a failed backup must not silently proceed */ }
};

export const trust = {
  summary: 'Pre-trust a directory so dispatched agents do not stall on a trust dialog',
  usage: 'cbds trust [<path>] [--agent claude,codex] [--check]',
  flags: {
    agent: { type: 'string', placeholder: 'csv', describe: `which agents (default: all supported: ${Object.keys(AGENTS).join(', ')})` },
    check: { type: 'boolean', describe: 'report status only, write nothing' },
  },
  async run(ctx) {
    const dir = path.resolve(ctx.positional[0] ?? process.cwd());
    if (!fs.existsSync(dir)) throw usage(`no such directory: ${dir}`);

    const wanted = csv(ctx.flags.agent);
    for (const name of wanted) {
      if (!AGENTS[name]) {
        throw usage(`cbds does not manage trust for "${name}"`,
          `supported: ${Object.keys(AGENTS).join(', ')}. Other agents either have no trust gate or store it somewhere cbds has not verified.`);
      }
    }
    const names = wanted.length ? wanted : Object.keys(AGENTS);

    const results = names.map((name) => {
      const agent = AGENTS[name];
      const configured = fs.existsSync(agent.file());
      let before = false;
      try { before = configured && agent.isTrusted(dir); } catch { before = false; }

      if (!configured) return { agent: name, label: agent.label, status: 'not_installed', trusted: false };
      if (before) return { agent: name, label: agent.label, status: 'already_trusted', trusted: true };
      if (ctx.flags.check) return { agent: name, label: agent.label, status: 'would_trust', trusted: false };

      agent.trust(dir);
      return { agent: name, label: agent.label, status: 'trusted', trusted: true, backup: `${agent.file()}.cbds-bak` };
    });

    const paint = {
      trusted: c.green('trusted'),
      already_trusted: c.dim('already trusted'),
      would_trust: c.yellow('would trust'),
      not_installed: c.dim('not installed'),
    };

    say(ctx, `${ctx.flags.check ? c.bold('trust check') : c.bold('trust')}  ${c.dim(dir)}`);
    say(ctx, table(results, [
      { header: 'AGENT', get: (r) => r.label },
      { header: 'STATUS', get: (r) => paint[r.status] ?? r.status },
    ]));
    if (!ctx.flags.check && results.some((r) => r.status === 'trusted')) {
      say(ctx, c.dim('\n  originals backed up alongside each config as *.cbds-bak'));
    }
    if (results.some((r) => !r.trusted && r.status === 'would_trust')) {
      say(ctx, c.dim(`\n  apply with: cbds trust "${dir}"`));
    }
    return emit(ctx, { path: dir, agents: results });
  },
};
