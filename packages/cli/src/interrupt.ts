import type { DispatchRunReporter } from './dispatchRunReporter.js';

// THE INTERRUPT (Story MOTIR-6526 · MOTIR-6530) — what every command that holds
// an open run does when somebody presses Ctrl-C, or the process is sent SIGTERM.
//
// A person who STOPS a run has made a decision, and the record should say so:
// the run closes `interrupted` (run status `cancelled`) after the events already
// queued are sent. Without this the process simply dies, the run reads `running`
// until its heartbeat lapses, and the page then describes a deliberate stop as a
// mysterious death five minutes later.
//
// ⚠️ IT WRITES NO WORK-ITEM STATUS. An interrupted run leaves its card exactly
// where it was — the direction `docs/decisions/run-death-keeps-work.md` §3 takes
// for every run end but success.
//
// ONE place for the two signals and their exit codes, so the five commands that
// open runs cannot disagree about either.

export type InterruptSignal = 'SIGINT' | 'SIGTERM';

/** The conventional `128 + signal` exit code for each. */
export const INTERRUPT_EXIT_CODE: Readonly<Record<InterruptSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * Bind `handler` to SIGINT and SIGTERM; return the remover. The production
 * binder — a command's tests inject their own and call the handler directly.
 */
export function bindInterruptSignals(handler: (signal: InterruptSignal) => void): () => void {
  const onInt = (): void => handler('SIGINT');
  const onTerm = (): void => handler('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return () => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  };
}

/**
 * Close the open run `interrupted` — flushing what is queued first, which
 * `reporter.close` does — and then end the process with the signal's code. The
 * reporter never throws, so the exit always follows.
 */
export function closeRunAndExit(
  reporter: DispatchRunReporter,
  signal: InterruptSignal,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  return reporter.close('interrupted').finally(() => exit(INTERRUPT_EXIT_CODE[signal]));
}
