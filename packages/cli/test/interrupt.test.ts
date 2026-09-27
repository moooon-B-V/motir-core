import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindInterruptSignals, closeRunAndExit, INTERRUPT_EXIT_CODE } from '../src/interrupt.js';
import type { DispatchRunReporter } from '../src/dispatchRunReporter.js';

// THE INTERRUPT (Story MOTIR-6526 · MOTIR-6530; coverage MOTIR-6537) — a run
// stopped from its terminal closes `interrupted` and exits with the signal's code.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bindInterruptSignals', () => {
  it('hands SIGINT and SIGTERM to the handler by name, and the remover unbinds both', () => {
    const handler = vi.fn();
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const remove = bindInterruptSignals(handler);
    process.emit('SIGINT');
    process.emit('SIGTERM');
    expect(handler.mock.calls).toEqual([['SIGINT'], ['SIGTERM']]);
    remove();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});

describe('closeRunAndExit', () => {
  const reporter = (close: () => Promise<void>) => ({ close }) as unknown as DispatchRunReporter;

  it('closes the run `interrupted`, then exits with 128 + the signal', async () => {
    const close = vi.fn(async () => {});
    const exit = vi.fn();
    await closeRunAndExit(reporter(close), 'SIGTERM', exit);
    expect(close).toHaveBeenCalledWith('interrupted');
    expect(exit).toHaveBeenCalledWith(INTERRUPT_EXIT_CODE.SIGTERM);
  });

  it('exits the PROCESS by default', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await closeRunAndExit(
      reporter(async () => {}),
      'SIGINT',
    );
    expect(exit).toHaveBeenCalledWith(130);
  });
});
