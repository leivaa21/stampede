/**
 * Putting the terminal back, whatever ends the run.
 *
 * The dashboard hides the cursor while it draws, and **Ctrl-C is the normal way to end a long load
 * test** — not an exotic path. Without this, interrupting a run leaves the user's shell with an
 * invisible cursor, which is a tool damaging the terminal on its most common exit.
 *
 * Separated from `cli.ts` so it can be tested: `cli.ts` runs on import, so anything living there is
 * only reachable by spawning a process inside a pty.
 */

export interface SignalTarget {
  once: (signal: string, handler: () => void) => void;
  off: (signal: string, handler: () => void) => void;
  exit: (code: number) => void;
}

/** 128 + the signal number, the code a shell reports for an interrupted process. */
export const SIGINT_EXIT = 130;
export const SIGTERM_EXIT = 143;

export interface TerminalGuard {
  /** Removes the handlers. Safe to call more than once. */
  readonly release: () => void;
}

/**
 * Runs `restore` before exiting on SIGINT or SIGTERM.
 *
 * Registered per run rather than for the process lifetime, so a run that ends normally leaves no
 * handler behind changing what a later Ctrl-C does.
 */
export const guardTerminal = (restore: () => void, target: SignalTarget): TerminalGuard => {
  const handlerFor = (code: number) => () => {
    restore();
    target.exit(code);
  };
  const onSigint = handlerFor(SIGINT_EXIT);
  const onSigterm = handlerFor(SIGTERM_EXIT);

  target.once("SIGINT", onSigint);
  target.once("SIGTERM", onSigterm);

  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      target.off("SIGINT", onSigint);
      target.off("SIGTERM", onSigterm);
    },
  };
};
