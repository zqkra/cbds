import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CBDS = path.resolve(HERE, '..', 'bin', 'cbds.mjs');

export const tmpProject = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbds-test-'));
  fs.mkdirSync(path.join(dir, '.git'));   // makes it the project root
  return dir;
};

/** Run the CLI as a real subprocess so exit codes are exercised, not simulated. */
export const cli = (cwd, args, env = {}) =>
  new Promise((resolve) => {
    execFile(process.execPath, [CBDS, ...args], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        NO_COLOR: '1',
        // Never let a test touch a real Herdr session.
        HERDR_ENV: env.HERDR_ENV ?? '',
        HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH ?? '',
      },
    }, (error, stdout, stderr) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* not a --json call */ }
      resolve({ code: error?.code ?? 0, stdout, stderr, json });
    });
  });

export const cliJson = async (cwd, args, env) => {
  const res = await cli(cwd, [...args, '--json'], env);
  return res;
};
