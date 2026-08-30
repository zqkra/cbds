#!/usr/bin/env node
/** Action: open the cbds board pane. */
import { spawnSync } from 'node:child_process';

const herdr = process.env.HERDR_BIN_PATH ?? 'herdr';
const pluginId = process.env.HERDR_PLUGIN_ID ?? 'dev.cbds.cbds';

const res = spawnSync(herdr, ['plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', 'board'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
process.stdout.write(res.stdout ?? '');
process.stderr.write(res.stderr ?? '');
process.exit(res.status ?? 1);
