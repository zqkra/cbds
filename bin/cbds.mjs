#!/usr/bin/env node
import { main } from '../src/cli.mjs';

process.on('unhandledRejection', (err) => {
  process.stderr.write(`cbds: unhandled rejection — ${err?.message ?? err}\n`);
  process.exit(1);
});

main(process.argv.slice(2)).then((code) => {
  // Let queued stdout flush before exiting, otherwise piped JSON can be truncated.
  process.exitCode = code;
  if (process.stdout.writableLength === 0) process.exit(code);
  process.stdout.once('drain', () => process.exit(code));
  setTimeout(() => process.exit(code), 250).unref();
});
