import { describe, expect, it } from 'vitest';
import { howToTestRefusal } from '@/lib/testInstructions/refusal';
import {
  TestInstructionsCapExceededError,
  TestInstructionsConflictError,
  TestInstructionsInvalidFieldError,
  TestInstructionsWorkItemNotFoundError,
} from '@/lib/testInstructions/errors';
import { normalizeTestInstructionsContent } from '@/lib/services/testInstructionsService';
import { TEST_INSTRUCTIONS_MAX_BODY_BYTES } from '@/lib/testInstructions/caps';

// WHERE a publish refusal lands in a person's form (Subtask MOTIR-5455; §24,
// decision 5). The WORDS are `publish`'s — one service refuses both author kinds
// — so what is worth testing is the placement, and the two ways it can go wrong:
// a refusal drawn beside the wrong field, and a refusal drawn nowhere at all.

describe('howToTestRefusal — placement', () => {
  it('places the two fields the form HAS beside themselves, without the `"field" is invalid` frame', () => {
    expect(
      howToTestRefusal(new TestInstructionsInvalidFieldError('bodyMd', 'write How to test.')),
    ).toEqual({ field: 'bodyMd', message: 'write How to test.' });
    expect(
      howToTestRefusal(
        new TestInstructionsInvalidFieldError('previewPath', 'expected a path starting with "/".'),
      ),
    ).toEqual({ field: 'previewPath', message: 'expected a path starting with "/".' });
  });

  it('a CAP refusal keeps its whole sentence — it names the limit, which is the actionable part', () => {
    const placed = howToTestRefusal(
      new TestInstructionsCapExceededError('bodyMd', TEST_INSTRUCTIONS_MAX_BODY_BYTES, 'bytes'),
    );
    expect(placed?.field).toBe('bodyMd');
    expect(placed?.message).toContain(String(TEST_INSTRUCTIONS_MAX_BODY_BYTES));
  });

  it('a refusal about a field the form does NOT draw lands on the form, never nowhere', () => {
    // Since MOTIR-5689 the form cannot produce one — it sends no sections — and
    // that is exactly why an arriving one must still be visible rather than
    // silently swallowed by a switch with no default.
    expect(
      howToTestRefusal(new TestInstructionsInvalidFieldError('repos[0].commitSha', 'not hex.')),
    ).toEqual({ field: null, message: 'not hex.' });
  });

  it('is NULL for an error that is not a refusal — the caller re-throws those', () => {
    expect(howToTestRefusal(new TestInstructionsWorkItemNotFoundError('wi-1'))).toBeNull();
    expect(howToTestRefusal(new TestInstructionsConflictError('wi-1'))).toBeNull();
    expect(howToTestRefusal(new Error('boom'))).toBeNull();
  });
});

describe('the three refusals the FORM can actually produce (§24, panel 13d)', () => {
  // Thrown by the real validator, not constructed by hand: the design says the
  // form shows `publish`'s own strings, so a test that invented them would agree
  // with itself while the product said something else.
  function refuseOf(input: { bodyMd: string; previewPath?: string | null }) {
    try {
      normalizeTestInstructionsContent({ workItemId: 'wi-1', ...input });
    } catch (err) {
      return howToTestRefusal(err);
    }
    return null;
  }

  it('an empty body — beside the body', () => {
    expect(refuseOf({ bodyMd: '   ' })).toEqual({
      field: 'bodyMd',
      message:
        'write How to test as Markdown — sections for the precondition, local setup and click-path, every command in a fenced code block.',
    });
  });

  it('a body over its cap — beside the body, naming the limit', () => {
    const placed = refuseOf({ bodyMd: 'x'.repeat(TEST_INSTRUCTIONS_MAX_BODY_BYTES + 1) });
    expect(placed?.field).toBe('bodyMd');
    expect(placed?.message).toContain(String(TEST_INSTRUCTIONS_MAX_BODY_BYTES));
  });

  it('a preview path that is not a single-slash path — beside the preview path', () => {
    expect(refuseOf({ bodyMd: '## Body', previewPath: 'https://evil.example/' })).toEqual({
      field: 'previewPath',
      message: 'expected a path starting with a single "/", e.g. "/items/ACME-7".',
    });
  });
});
