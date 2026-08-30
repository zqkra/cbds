/**
 * Stable exit-code contract. Documented in README and depended on by orchestrators,
 * so these numbers are API: never renumber them.
 */
export const EXIT = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  TIMEOUT: 4,
  STALE_DISPATCH: 5,
  NO_HERDR: 6,
  CONFLICT: 7,
  WORKER_VANISHED: 8,
  CONTRACT_UNDELIVERED: 9,
};

export const EXIT_NAMES = Object.fromEntries(
  Object.entries(EXIT).map(([name, code]) => [code, name.toLowerCase()]),
);

/**
 * Every expected failure in cbds is a CbdsError. Anything else escaping to the top
 * level is a bug and is reported as such rather than being swallowed.
 */
export class CbdsError extends Error {
  constructor(code, message, { exit = EXIT.FAILURE, details = null, hint = null } = {}) {
    super(message);
    this.name = 'CbdsError';
    this.code = code;
    this.exit = exit;
    this.details = details;
    this.hint = hint;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      exit: this.exit,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export const usage = (msg, hint) =>
  new CbdsError('usage', msg, { exit: EXIT.USAGE, hint });
export const notFound = (kind, id) =>
  new CbdsError(`${kind}_not_found`, `no such ${kind}: ${id}`, { exit: EXIT.NOT_FOUND });
export const conflict = (code, msg, hint) =>
  new CbdsError(code, msg, { exit: EXIT.CONFLICT, hint });
export const stale = (code, msg, details) =>
  new CbdsError(code, msg, { exit: EXIT.STALE_DISPATCH, details });
export const noHerdr = (msg, hint) =>
  new CbdsError('herdr_unavailable', msg, { exit: EXIT.NO_HERDR, hint });
