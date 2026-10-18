import { describe, expect, it } from 'vitest';
import {
  MotirAiBadRequestError,
  MotirAiOutOfCreditsError,
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
  errorFromProblem,
  isPerInputRejection,
} from '@/lib/ai/errors';

// MOTIR-8227 — the embedding sweep blames an ITEM only for a rejection that is
// about the input. The HTTP status carried on `MotirAiBadRequestError` is how it
// tells one from a provider-wide fault without matching on message text.
describe('isPerInputRejection', () => {
  it.each([400, 413, 422])('a %i rejection is about the input', (status) => {
    expect(isPerInputRejection(new MotirAiBadRequestError('bad', status))).toBe(true);
  });

  it.each([401, 403, 404, 429])('a %i bad request is not attributable to one input', (status) => {
    expect(isPerInputRejection(new MotirAiBadRequestError('bad', status))).toBe(false);
  });

  it('a bad request with no recorded status is never attributed', () => {
    expect(isPerInputRejection(new MotirAiBadRequestError('bad'))).toBe(false);
  });

  it('transport, auth and credit failures are outages, not input faults', () => {
    expect(isPerInputRejection(new MotirAiUnavailableError('down'))).toBe(false);
    expect(isPerInputRejection(new MotirAiUnauthorizedError('nope'))).toBe(false);
    expect(isPerInputRejection(new MotirAiOutOfCreditsError('broke'))).toBe(false);
    expect(isPerInputRejection(new Error('plain'))).toBe(false);
  });

  it('errorFromProblem threads the wire status onto the validation error', () => {
    const err = errorFromProblem({
      code: 'validation_error',
      status: 422,
      title: 'Validation error',
      detail: 'input too long',
    } as Parameters<typeof errorFromProblem>[0]);
    expect(err).toBeInstanceOf(MotirAiBadRequestError);
    expect(isPerInputRejection(err)).toBe(true);
  });
});
