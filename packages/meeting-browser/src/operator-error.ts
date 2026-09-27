/**
 * An error whose MESSAGE is the whole report, and whose stack is noise.
 *
 * Every prerequisite of a meeting join — a display name, a records path, an
 * audio device, a reachable Chrome — is something an operator gets wrong while
 * a meeting is starting. What they need at that moment is one paragraph saying
 * what to set; a JavaScript stack trace is a message that has to be decoded
 * first, and decoding takes longer than the meeting takes to start without
 * them.
 *
 * The distinction is deliberately NOT "was it thrown by us": a bug in this
 * package still deserves its stack, because nobody can act on a bug they
 * cannot locate. This marks only the errors whose entire content is an
 * instruction to the person running the command.
 */
export abstract class OperatorFacingError extends Error {
  readonly operatorFacing = true;
}

/** Whether a caller should print `error.message` alone rather than the error.
 *
 * Structural rather than `instanceof`: a CLI and a transport that reach each
 * other through a package boundary can end up with two copies of the class
 * (one from `dist`, one from source, or two versions during an upgrade), and
 * an `instanceof` that silently fails there degrades the message back into the
 * stack trace this class exists to suppress — at the exact moment it matters,
 * and with no signal that it happened.
 */
export function isOperatorFacingError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error as Partial<OperatorFacingError>).operatorFacing === true &&
    typeof error.message === "string"
  );
}
