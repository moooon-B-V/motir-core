import { describe, expect, it } from 'vitest';

import { grillFailedAfterHandoff } from '@/lib/planning/grillHandoff';

const open = (failed: boolean) => ({
  status: 'open' as const,
  turns: [{ failed }] as never,
});

describe('grillFailedAfterHandoff (MOTIR-8781)', () => {
  it('says so when the run is writing, Grill me is on and the last turn failed', () => {
    expect(
      grillFailedAfterHandoff({ writing: true, on: true, session: open(true), error: null }),
    ).toBe(true);
  });

  it('says so when the hook holds an error and no session ever opened', () => {
    expect(
      grillFailedAfterHandoff({ writing: true, on: true, session: null, error: 'failed' }),
    ).toBe(true);
    expect(
      grillFailedAfterHandoff({ writing: true, on: true, session: null, error: 'outOfCredits' }),
    ).toBe(true);
  });

  it('stays quiet while the run is still conversing (the thread draws its own error)', () => {
    expect(
      grillFailedAfterHandoff({ writing: false, on: true, session: open(true), error: 'failed' }),
    ).toBe(false);
  });

  it('stays quiet when the person never turned Grill me on', () => {
    expect(
      grillFailedAfterHandoff({ writing: true, on: false, session: open(true), error: 'failed' }),
    ).toBe(false);
  });

  it('stays quiet for an ended session, which draws its own summary', () => {
    expect(
      grillFailedAfterHandoff({
        writing: true,
        on: true,
        session: { status: 'ended', turns: [{ failed: true }] as never },
        error: 'failed',
      }),
    ).toBe(false);
  });

  it('stays quiet when the last turn was fine and nothing errored', () => {
    expect(
      grillFailedAfterHandoff({ writing: true, on: true, session: open(false), error: null }),
    ).toBe(false);
    expect(grillFailedAfterHandoff({ writing: true, on: true, session: null, error: null })).toBe(
      false,
    );
  });
});
