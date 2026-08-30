import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CBDS_BIN_DIR = path.resolve(HERE, '..', '..', 'bin');
export const CBDS_BIN_PATH = path.join(CBDS_BIN_DIR, 'cbds.mjs');

const onPath = (name) => {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, name + ext);
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* keep looking */ }
    }
  }
  return null;
};

const quote = (p) => (/[\s"']/.test(p) ? JSON.stringify(p) : p);

/**
 * How the worker should invoke cbds.
 *
 * This MUST be a single word. A plugin-installed cbds is not necessarily on the
 * worker's PATH, and the obvious fallback — `node /path/to/cbds.mjs` in an env var —
 * is broken by design: fish (and any non-POSIX shell) does not word-split variables,
 * so `$CBDS_BIN done ...` becomes a command named "node /path/to/cbds.mjs" and fails.
 * A worker that cannot run the command is a silent completion failure, which is the
 * exact class of bug cbds exists to eliminate.
 *
 * So cbds ships a real executable shim (bin/cbds, bin/cbds.cmd) and injects its
 * directory onto the worker's PATH. The contract command is always literally `cbds`.
 */
export const resolveCbdsCommand = () => 'cbds';

/** PATH for the worker pane, with the cbds shim dir first (deduped). */
export const workerPath = (basePath = process.env.PATH ?? '') => {
  const parts = basePath.split(path.delimiter).filter(Boolean);
  return [CBDS_BIN_DIR, ...parts.filter((p) => path.resolve(p) !== CBDS_BIN_DIR)]
    .join(path.delimiter);
};

/** True when a `cbds` executable already resolves without our injection. */
export const cbdsOnPath = () => Boolean(onPath('cbds'));

const RULE = '━'.repeat(70);

/**
 * Build the worker preamble.
 *
 * Deliberately agent-agnostic: it assumes only a shell and the `cbds` binary, so the
 * same bytes work for claude, codex, opencode, pi, grok, hermes, gemini, cursor,
 * droid, amp, kiro, qwen and any future Herdr agent kind. There is no per-agent
 * templating to drift out of date.
 *
 * Identity is delivered TWICE on purpose:
 *   - in the pane environment (machine-readable, immune to paraphrase, survives
 *     scrollback loss on the alternate screen), and
 *   - in prose (so the agent understands the obligation it is under).
 */
export const buildPreamble = ({ run, task, dispatch, cbdsCommand = resolveCbdsCommand() }) => {
  const lines = [
    RULE,
    'CBDS DISPATCH — you are a cbds worker.',
    'A coordinator is blocked waiting for your report. Read the contract at the bottom.',
    '',
    `  run_id       ${run.run_id}`,
    `  task_id      ${task.task_id}`,
    `  dispatch_id  ${dispatch.dispatch_id}`,
    `  attempt      ${dispatch.attempt} of ${task.max_attempts}`,
    '',
    `OBJECTIVE (run)  ${run.objective}`,
    '',
    `TASK — ${task.title}`,
    task.spec,
    '',
    'COMPLETION CONTRACT — non-negotiable',
    '',
    '1. Do the task.',
    '2. Then run EXACTLY ONE of these from this pane’s shell:',
    '',
    `     ${cbdsCommand} done --outcome succeeded \\`,
    '       --subject "<one line>" \\',
    '       --body "<what you did, what you found, what remains>" \\',
    '       --files-modified "path/a,path/b"',
    '',
    `     ${cbdsCommand} done --outcome failed \\`,
    '       --subject "<one line>" --body "<why it failed and what you tried>"',
    '',
    `     ${cbdsCommand} done --outcome blocked \\`,
    '       --subject "<one line>" --question "<exactly what you need to proceed>"',
    '',
    '3. Send it EXACTLY ONCE, including on failure. Never encode failure only in prose:',
    '   an unreported failure looks identical to a hung worker.',
    '4. Then stop and idle at your prompt. Do not start new work, do not poll,',
    '   do not close this pane. The coordinator owns cleanup.',
    '',
    'Your identity is already in this pane’s environment (CBDS_RUN_ID, CBDS_TASK_ID,',
    `CBDS_DISPATCH_ID), so the ids above are optional: \`${cbdsCommand} done --outcome succeeded`,
    '--body "…"` is enough. Pass --task-id and --dispatch-id only if you need them explicit.',
    '',
    `Check your identity at any time with:  ${cbdsCommand} whoami`,
    'If that command reports no dispatch, this preamble is STALE — inherited from',
    'scrollback or a previous handoff. Do not report; tell the user instead.',
    RULE,
  ];
  return lines.join('\n');
};

export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Environment injected into the worker pane at split time. This is the durable half
 * of the identity contract: `cbds done` needs no arguments because of it.
 */
export const workerEnv = ({ run, task, dispatch, stateDir, depth }) => ({
  CBDS_RUN_ID: run.run_id,
  CBDS_TASK_ID: task.task_id,
  CBDS_DISPATCH_ID: dispatch.dispatch_id,
  CBDS_STATE_DIR: stateDir,
  CBDS_ROLE: 'worker',
  CBDS_DEPTH: String(depth),
  CBDS_BIN: 'cbds',
  // The shim dir goes first so `cbds` is a single word in every shell, including fish.
  PATH: workerPath(),
});
