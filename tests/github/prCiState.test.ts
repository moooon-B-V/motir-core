import { describe, expect, it } from 'vitest';
import { derivePrCiState, type PrCheckRunSlice } from '@/lib/github/prCiState';

// Story 7.10 · MOTIR-1579 — the per-PR CI derivation behind the Development
// surface's CI pill. Pure unit: precedence (failing > running > passing) at
// the LATEST recorded sha, the sha window itself, and the null cases (no rows
// / no known conclusion → NO pill, absence of CI is not a state).

function run(commitSha: string, conclusion: string, createdAt: string): PrCheckRunSlice {
  return { commitSha, conclusion, createdAt: new Date(createdAt) };
}

describe('derivePrCiState (MOTIR-1579)', () => {
  it('returns null for no rows (no CI pill — absence is not a state)', () => {
    expect(derivePrCiState([])).toBeNull();
  });

  it('all success at the head sha → passing', () => {
    expect(
      derivePrCiState([
        run('sha1', 'success', '2026-07-01T10:00:00Z'),
        run('sha1', 'success', '2026-07-01T10:01:00Z'),
      ]),
    ).toBe('passing');
  });

  it('any failure wins over pending AND success (failing > running > passing)', () => {
    expect(
      derivePrCiState([
        run('sha1', 'success', '2026-07-01T10:00:00Z'),
        run('sha1', 'pending', '2026-07-01T10:01:00Z'),
        run('sha1', 'failure', '2026-07-01T10:02:00Z'),
      ]),
    ).toBe('failing');
  });

  it('pending wins over success (a half-finished suite is running, not passing)', () => {
    expect(
      derivePrCiState([
        run('sha1', 'success', '2026-07-01T10:00:00Z'),
        run('sha1', 'pending', '2026-07-01T10:01:00Z'),
      ]),
    ).toBe('running');
  });

  it("derives at the LATEST sha only — an old sha's failure never haunts a new push", () => {
    expect(
      derivePrCiState([
        run('shaOld', 'failure', '2026-07-01T10:00:00Z'),
        run('shaNew', 'pending', '2026-07-01T11:00:00Z'),
      ]),
    ).toBe('running');
  });

  it('the sha window keys on first sighting (createdAt) — a re-run on an old sha never outranks a newer push', () => {
    // The old sha's row was UPDATED after the new push (a re-run refreshes
    // updatedAt, not createdAt) — createdAt ordering keeps shaNew the head.
    expect(
      derivePrCiState([
        run('shaNew', 'success', '2026-07-01T11:00:00Z'),
        run('shaOld', 'failure', '2026-07-01T10:00:00Z'),
      ]),
    ).toBe('passing');
  });

  it('rows with no known conclusion at the head sha → null', () => {
    expect(derivePrCiState([run('sha1', 'neutral', '2026-07-01T10:00:00Z')])).toBeNull();
  });
});
