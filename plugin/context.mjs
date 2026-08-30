import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CBDS_BIN = path.join(PLUGIN_ROOT, 'bin', 'cbds.mjs');

/** Herdr passes the full invocation context as JSON. Never assume it parses. */
export const context = () => {
  try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? '{}'); } catch { return {}; }
};

export const event = () => {
  try { return JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? '{}'); } catch { return {}; }
};

/**
 * Where should this plugin invocation operate?
 *
 * Plugin commands run with cwd = plugin root, which has no `.cbds`. The useful
 * directory is the pane's. Herdr 0.8.x supplies the context with FLAT keys
 * (`focused_pane_cwd`, `workspace_cwd`); nested forms are also accepted so a future
 * shape change degrades instead of breaking. Every candidate is stat-checked, because
 * a stale path must not silently redirect the store to the wrong project.
 */
export const targetCwd = () => {
  const ctx = context();
  const candidates = [
    ctx.pane_cwd, ctx.focused_pane_cwd, ctx.workspace_cwd, ctx.worktree_path, ctx.cwd,
    ctx.pane?.foreground_cwd, ctx.pane?.cwd, ctx.workspace?.cwd, ctx.worktree?.path,
    process.env.HERDR_PLUGIN_CWD,
  ].filter(Boolean);
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* next candidate */ }
  }
  return process.cwd();
};

/** The pane this invocation is about, across flat and nested context shapes. */
export const contextPaneId = () => {
  const ctx = context();
  return ctx.pane_id ?? ctx.focused_pane_id ?? ctx.pane?.pane_id ?? process.env.HERDR_PANE_ID ?? null;
};

/** Nearest ancestor that already has a `.cbds` store, so the board finds an existing run. */
export const findStore = (start) => {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.cbds', 'VERSION'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};
