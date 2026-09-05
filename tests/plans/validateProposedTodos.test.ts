import { describe, expect, it } from 'vitest';
import { validateProposedTodos } from '@/lib/plans/validateProposedTodos';
import { InvalidProposalError } from '@/lib/plans/errors';
import {
  TODO_COMMAND_MAX_LENGTH,
  TODO_NOTES_MAX_LENGTH,
  TODO_TEXT_MAX_LENGTH,
} from '@/lib/workItemTodos/limits';

// MOTIR-4616 — the proposed to-do list's bar, as pure logic (no DB).
// `docs/decisions/agent-authored-plans.md` AMENDMENT 13 D4.
//
// ⚠️ EVERY LENGTH HERE IS BUILT FROM THE IMPORTED CONSTANT, never from a
// literal — the same discipline `lib/workItemTodos/limits.ts`'s own header
// asks of "the service, the DTO's documented contract, the error message a
// user reads and every test". A suite that hard-codes `200` is a fourth home
// for the number and would go green against a cap that had moved.

const LABEL = 'add "Provision the DNS records"';

/** A string of exactly `n` characters. */
function chars(n: number): string {
  return 'x'.repeat(n);
}

describe('validateProposedTodos — the absent cases', () => {
  it('passes on undefined and null: a proposal with no steps is the ordinary case', () => {
    expect(() => validateProposedTodos(undefined, 'subtask', LABEL)).not.toThrow();
    expect(() => validateProposedTodos(null, 'subtask', LABEL)).not.toThrow();
  });

  it('passes on an empty array, and on a container with an empty array', () => {
    expect(() => validateProposedTodos([], 'subtask', LABEL)).not.toThrow();
    // The container gate reads the LENGTH, not the presence of the key: `[]` is
    // "no steps", which is exactly what a story is allowed to have.
    expect(() => validateProposedTodos([], 'story', LABEL)).not.toThrow();
  });

  it('refuses a non-array', () => {
    expect(() => validateProposedTodos('do the thing', 'subtask', LABEL)).toThrow(
      InvalidProposalError,
    );
    expect(() => validateProposedTodos({ text: 'x' }, 'subtask', LABEL)).toThrow(
      InvalidProposalError,
    );
  });
});

describe('validateProposedTodos — the caps, at the boundary and one past it', () => {
  it('accepts `text` at exactly the cap and refuses it one character over', () => {
    expect(() =>
      validateProposedTodos([{ text: chars(TODO_TEXT_MAX_LENGTH) }], 'subtask', LABEL),
    ).not.toThrow();
    expect(() =>
      validateProposedTodos([{ text: chars(TODO_TEXT_MAX_LENGTH + 1) }], 'subtask', LABEL),
    ).toThrow(InvalidProposalError);
  });

  it('accepts `notesMd` at exactly the cap and refuses it one character over', () => {
    expect(() =>
      validateProposedTodos(
        [{ text: 'Create the key', notesMd: chars(TODO_NOTES_MAX_LENGTH) }],
        'subtask',
        LABEL,
      ),
    ).not.toThrow();
    expect(() =>
      validateProposedTodos(
        [{ text: 'Create the key', notesMd: chars(TODO_NOTES_MAX_LENGTH + 1) }],
        'subtask',
        LABEL,
      ),
    ).toThrow(InvalidProposalError);
  });

  it('accepts `commandText` at exactly the cap and refuses it one character over', () => {
    expect(() =>
      validateProposedTodos(
        [{ text: 'Run the migration', commandText: chars(TODO_COMMAND_MAX_LENGTH) }],
        'subtask',
        LABEL,
      ),
    ).not.toThrow();
    expect(() =>
      validateProposedTodos(
        [{ text: 'Run the migration', commandText: chars(TODO_COMMAND_MAX_LENGTH + 1) }],
        'subtask',
        LABEL,
      ),
    ).toThrow(InvalidProposalError);
  });

  it('measures the TRIMMED value, the way the store does', () => {
    // `requireText` / `normalizeNotes` / `normalizeCommand` all trim before they
    // compare, so a proposal judged on the raw string would refuse a step the
    // card itself would accept.
    const padded = `  ${chars(TODO_TEXT_MAX_LENGTH)}  `;
    expect(() => validateProposedTodos([{ text: padded }], 'subtask', LABEL)).not.toThrow();
  });
});

describe('validateProposedTodos — the row shape', () => {
  it('requires `text`, and refuses an empty or whitespace-only one', () => {
    expect(() => validateProposedTodos([{ text: '' }], 'subtask', LABEL)).toThrow(
      InvalidProposalError,
    );
    expect(() => validateProposedTodos([{ text: '   ' }], 'subtask', LABEL)).toThrow(
      InvalidProposalError,
    );
    expect(() => validateProposedTodos([{ notesMd: 'how' }], 'subtask', LABEL)).toThrow(
      InvalidProposalError,
    );
  });

  it('refuses a row that is not an object', () => {
    expect(() => validateProposedTodos(['do the thing'], 'subtask', LABEL)).toThrow(
      InvalidProposalError,
    );
    expect(() => validateProposedTodos([null], 'subtask', LABEL)).toThrow(InvalidProposalError);
  });

  it('accepts both executors and null, and refuses anything else', () => {
    expect(() =>
      validateProposedTodos(
        [
          { text: 'Create the key', executor: 'human' },
          { text: 'Wire it into the env', executor: 'coding_agent' },
          { text: 'Inherit the card’s', executor: null },
          { text: 'Omit it entirely' },
        ],
        'subtask',
        LABEL,
      ),
    ).not.toThrow();
    expect(() =>
      validateProposedTodos([{ text: 'Create the key', executor: 'robot' }], 'subtask', LABEL),
    ).toThrow(InvalidProposalError);
  });

  it('refuses a non-string `notesMd` / `commandText`', () => {
    expect(() => validateProposedTodos([{ text: 'x', notesMd: 7 }], 'subtask', LABEL)).toThrow(
      InvalidProposalError,
    );
    expect(() => validateProposedTodos([{ text: 'x', commandText: 7 }], 'subtask', LABEL)).toThrow(
      InvalidProposalError,
    );
  });

  it('names the 1-based ROW INDEX in the refusal, so an agent can act on it', () => {
    expect(() =>
      validateProposedTodos(
        [{ text: 'fine' }, { text: 'also fine' }, { text: chars(TODO_TEXT_MAX_LENGTH + 1) }],
        'subtask',
        LABEL,
      ),
    ).toThrow(/step 3/);
  });
});

describe('validateProposedTodos — the container gate (AMENDMENT 13 D4)', () => {
  it('allows a non-empty list on every LEAF kind', () => {
    for (const kind of ['task', 'subtask', 'bug']) {
      expect(() => validateProposedTodos([{ text: 'Create the key' }], kind, LABEL)).not.toThrow();
    }
  });

  it('refuses a non-empty list on a container kind — its steps are its children', () => {
    for (const kind of ['epic', 'story']) {
      expect(() => validateProposedTodos([{ text: 'Create the key' }], kind, LABEL)).toThrow(
        InvalidProposalError,
      );
    }
    expect(() => validateProposedTodos([{ text: 'Create the key' }], 'story', LABEL)).toThrow(
      /container/,
    );
  });

  it('refuses an UNKNOWN kind carrying steps rather than waving it through', () => {
    // The gate asks "is this a typeable leaf?", and an unrecognised kind is not
    // one. Failing open here would make a typo the one way to smuggle a
    // checklist onto a container.
    expect(() => validateProposedTodos([{ text: 'Create the key' }], 'programme', LABEL)).toThrow(
      InvalidProposalError,
    );
  });
});
