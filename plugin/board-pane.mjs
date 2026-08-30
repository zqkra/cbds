#!/usr/bin/env node
/** Entry point for the `board` pane declared in herdr-plugin.toml. */
import { targetCwd, findStore } from './context.mjs';

const start = targetCwd();
process.chdir(findStore(start) ?? start);

process.argv = [process.argv[0], 'cbds', 'board'];
await import('../src/cli.mjs').then(({ main }) => main(['board']));
