import { usage } from '../core/errors.mjs';

/**
 * Per-agent translation of `--model` / `--effort` into that agent's own argv.
 *
 * Only kinds whose CLI was actually verified appear here. Guessing a flag for an
 * unverified agent would produce a pane that dies on a bad argument, which reads to
 * an orchestrator as a mysterious dispatch failure. For anything else, cbds refuses
 * and points at `--`, which is always correct because Herdr forwards it verbatim.
 */
const LAUNCH = {
  claude: {
    model: (m) => ['--model', m],
    effort: (e) => ['--effort', e],
  },
  codex: {
    model: (m) => ['--model', m],
    // Codex takes reasoning effort as a config override, not a flag.
    effort: (e) => ['-c', `model_reasoning_effort="${e}"`],
  },
};

export const supportsLaunchOptions = (kind) => Boolean(LAUNCH[kind]);
export const launchKinds = () => Object.keys(LAUNCH);

/**
 * Build the agent argv for a dispatch.
 *
 * `extra` (everything after `--`) is appended last so an explicit native argument
 * always wins over cbds's translation.
 */
export const buildAgentArgs = ({ kind, model = null, effort = null, extra = [] }) => {
  if (!model && !effort) return [...extra];

  const spec = LAUNCH[kind];
  if (!spec) {
    throw usage(
      `--model/--effort is not mapped for agent kind "${kind}"`,
      `cbds only translates these for verified CLIs (${launchKinds().join(', ')}). For any other agent pass its native arguments after --, e.g.: cbds dispatch start --task <id> --agent ${kind} -- <native args>`,
    );
  }
  if (effort && !model) {
    throw usage('--effort requires --model',
      'effort is meaningless without the model it applies to');
  }

  const args = [];
  if (model) args.push(...spec.model(model));
  if (effort) args.push(...spec.effort(effort));
  return [...args, ...extra];
};
