import { emit, say } from '../core/output.mjs';
import { buildContractText, resolveCbdsCommand } from '../herdr/preamble.mjs';

/**
 * The full worker protocol, on demand.
 *
 * This command is what lets the injected preamble stay small. The dispatch pushes
 * only the rules a worker cannot complete correctly without; everything optional —
 * heartbeat, ask, escalate, check, the post-report nuances — lives here and is
 * pulled by the worker if and when it needs it. Nothing is lost, it just does not
 * ride along on every dispatch.
 */
export const contract = {
  summary: 'Print the full cbds worker protocol (workers: run this if you need more than `done`)',
  usage: 'cbds contract',
  flags: {
    'bare-shell': { type: 'boolean', describe: 'show the bare-shell variant of the post-report rules' },
  },
  async run(ctx) {
    const text = buildContractText({
      cbdsCommand: resolveCbdsCommand(),
      workerKind: ctx.flags['bare-shell'] ? 'bare-shell' : 'agent',
    });
    say(ctx, text);
    return emit(ctx, { contract: text });
  },
};
