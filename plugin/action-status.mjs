#!/usr/bin/env node
/** Action: print cbds status for the pane's project. */
import { targetCwd, findStore } from './context.mjs';
import { main } from '../src/cli.mjs';

const start = targetCwd();
process.chdir(findStore(start) ?? start);
process.exit(await main(['status']));
