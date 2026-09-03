import { afterEach, describe, expect, it, vi } from 'vitest';
import { narrateFrame } from '@/lib/hooks/usePlanChangeConversation';
import {
  FRAME_DISPOSITIONS,
  PLAN_CHANGE_FRAME_KINDS,
  isKnownFrameKind,
} from '@/lib/planning/planChangeFrames';

// THE RENDERER IS TOTAL (Story MOTIR-4054 · MOTIR-4069).
//
// ⚠️ WHAT THE CARD ASKED FOR, AND WHAT IT COULD NOT HAVE. It asks for totality
// "over the frame contract … enumerated from the contract, never from a
// hand-written list in the test". There WAS no contract: a frame's kind is a bare
// `string` on both sides of the wire, so there was nothing to enumerate from and
// no way to write this file as specified. `lib/planning/planChangeFrames.ts` is
// that enumeration, created by this card, and the tests below read it rather than
// restating it — which is the property the card's clause was protecting: the
// renderer and the test cannot drift, because there is only one list.
//
// The rest of that clause is answered by the TYPE rather than by a test:
// `FRAME_DISPOSITIONS` is a `Record<PlanChangeFrameKind, …>`, so a kind added to
// the union without a disposition does not compile. A test can only fail after
// somebody runs it; this fails while they are typing.

afterEach(() => {
  vi.restoreAllMocks();
});

/** Silence the loud default's console.warn for the cases that expect it. */
function withQuietConsole<T>(fn: () => T): T {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

describe('every frame kind is ACCOUNTED FOR', () => {
  it('the enumeration and the disposition map are the same set', () => {
    // Not a restatement of either — a check that the two agree, which is what
    // makes reading one of them sufficient everywhere else.
    expect(Object.keys(FRAME_DISPOSITIONS).sort()).toEqual([...PLAN_CHANGE_FRAME_KINDS].sort());
  });

  it('⚠️ NOTHING FALLS THROUGH — every kind is a decision, driven from the contract', () => {
    // The card's own words: "the renderer accounts for every frame kind". Not
    // "renders" — a line for all 51 would make the rail a log, which the design
    // rejects. What is forbidden is NEITHER: a kind nobody decided about.
    const unaccounted: string[] = [];
    for (const kind of PLAN_CHANGE_FRAME_KINDS) {
      const disposition = FRAME_DISPOSITIONS[kind];
      const decided = 'show' in disposition || 'quiet' in disposition;
      if (!decided) unaccounted.push(kind);
    }
    expect(unaccounted).toEqual([]);
  });

  it('a SHOW kind narrates something; a QUIET kind narrates nothing, on purpose', () => {
    for (const kind of PLAN_CHANGE_FRAME_KINDS) {
      const disposition = FRAME_DISPOSITIONS[kind];
      // Payloads every SHOW arm can read something out of, so a null here means
      // the arm is missing rather than the fixture being thin.
      const narrated = narrateFrame(kind, {
        proposed: 3,
        family: 'plan_tree',
        target: 'MOTIR-1',
        title: 'A card',
        text: 'because the billing epic already owns it',
      });
      if ('show' in disposition) {
        expect(narrated, `${kind} is SHOW and must narrate`).not.toBeNull();
      } else {
        expect(narrated, `${kind} is QUIET and must not`).toBeNull();
      }
    }
  });

  it('every QUIET decision carries its REASON', () => {
    // A bare `false` would be the same silent decision this card repairs, one
    // layer up: the reason is what makes "we do not show this" reviewable.
    for (const kind of PLAN_CHANGE_FRAME_KINDS) {
      const disposition = FRAME_DISPOSITIONS[kind];
      if ('quiet' in disposition) {
        expect(disposition.quiet.length, `${kind} needs a reason`).toBeGreaterThan(10);
      }
    }
  });
});

describe('AN UNKNOWN KIND IS LOUD — asserted on the ABSENCE of the silent path', () => {
  // ⚠️ THIS IS THE ASSERTION THE CARD IS ACTUALLY ABOUT. A test that checked the
  // known kinds render would have passed on every day `retrieval` was invisible,
  // because the defect was never in the arms — it was in the `default: return
  // null` beneath them.
  it('does not return null for a frame nobody has decided about', () => {
    withQuietConsole(() => {
      for (const invented of ['some_future_frame', 'token_stream', 'zzz', 'retrievalX']) {
        expect(isKnownFrameKind(invented)).toBe(false);
        const narrated = narrateFrame(invented, { x: 1 });
        expect(narrated, `${invented} was dropped silently`).not.toBeNull();
        expect(narrated).toEqual({ kind: 'unknown', frame: invented });
      }
    });
  });

  it('says so where a DEVELOPER sees it, naming the frame and the file to fix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    narrateFrame('some_future_frame', {});
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('some_future_frame');
    // The message has to be actionable, not merely present: whoever sees it in a
    // console needs to know where the list lives.
    expect(message).toContain('planChangeFrames');
    warn.mockRestore();
  });

  it('carries the RAW kind, so the loud line says WHICH frame arrived', () => {
    withQuietConsole(() => {
      expect(narrateFrame('a_brand_new_act', {})).toEqual({
        kind: 'unknown',
        frame: 'a_brand_new_act',
      });
    });
  });
});

describe('`retrieval` — the frame this card exists for', () => {
  it('narrates the FAMILY the planner looked in', () => {
    for (const family of ['plan_tree', 'code_graph', 'code_health', 'web', 'lessons']) {
      expect(narrateFrame('retrieval', { tool: 'get_item', family })).toEqual({
        kind: 'retrieval',
        family,
        blocked: false,
      });
    }
  });

  it('reads the BUDGET-EXHAUSTED variant as its own thing', () => {
    // A different sentence, not a suffix: the run has stopped being able to look
    // anything up, which is worth saying plainly.
    expect(
      narrateFrame('retrieval', { tool: 'get_item', family: 'plan_tree', blocked: true }),
    ).toEqual({ kind: 'retrieval', family: 'plan_tree', blocked: true });
  });

  it('survives a payload with no family rather than rendering "undefined"', () => {
    expect(narrateFrame('retrieval', {})).toEqual({
      kind: 'retrieval',
      family: null,
      blocked: false,
    });
  });
});

describe('`lay` and `author` name what they act on — and survive a thin payload', () => {
  it('names the target being laid and the title being written', () => {
    expect(narrateFrame('lay', { target: 'MOTIR-42', depth: 1 })).toEqual({
      kind: 'laying',
      target: 'MOTIR-42',
    });
    expect(narrateFrame('author', { ref: 'MOTIR-43', kind: 'subtask', title: 'The stop' })).toEqual(
      {
        kind: 'authoring',
        title: 'The stop',
      },
    );
  });

  it('a missing or non-string target / title is null, never the string "undefined"', () => {
    expect(narrateFrame('lay', {})).toEqual({ kind: 'laying', target: null });
    expect(narrateFrame('lay', { target: 7 })).toEqual({ kind: 'laying', target: null });
    expect(narrateFrame('author', { title: null })).toEqual({ kind: 'authoring', title: null });
    expect(narrateFrame('author', undefined)).toEqual({ kind: 'authoring', title: null });
  });

  it('`retrieval` reads `blocked` as a strict boolean — a truthy string is not a blocked lookup', () => {
    expect(narrateFrame('retrieval', { family: 3, blocked: 'yes' })).toEqual({
      kind: 'retrieval',
      family: null,
      blocked: false,
    });
  });
});

describe('the planner’s PROSE line', () => {
  it('renders the text the planner wrote', () => {
    expect(
      narrateFrame('note', {
        act: 'author',
        ref: 'MOTIR-1',
        text: '  the billing epic already owns this  ',
      }),
    ).toEqual({
      kind: 'note',
      text: 'the billing epic already owns this',
    });
  });

  it('⚠️ ITS ABSENCE IS NOT AN EMPTY ROW', () => {
    // The producer already refuses to emit a blank note — "a blank line is not a
    // shorter line, it is a line the rail would render as a hole" — and this is
    // the same refusal on our side, because a hole is what a bad payload draws.
    for (const text of ['', '   ', '\n\t ', undefined, null, 42]) {
      expect(narrateFrame('note', { text }), String(text)).toBeNull();
    }
  });
});

describe('NO frame kind currently rendered changes its output', () => {
  // This card's whole risk is a totality refactor quietly restyling what already
  // worked, so the shipped six are pinned exactly as they were.
  it('the six arms that shipped before this card are byte-identical', () => {
    expect(narrateFrame('search', {})).toEqual({ kind: 'searching' });
    expect(narrateFrame('drill', {})).toEqual({ kind: 'drilling' });
    expect(narrateFrame('pass', { proposed: 4 })).toEqual({ kind: 'proposed', count: 4 });
    expect(narrateFrame('planned', { proposed: 'lots' })).toEqual({ kind: 'proposed', count: 0 });
    expect(narrateFrame('level_complete', {})).toEqual({ kind: 'proposed', count: 0 });
    expect(narrateFrame('validated', {})).toEqual({ kind: 'validating' });
    expect(narrateFrame('validation_skipped', {})).toEqual({ kind: 'validating' });
  });

  it('still tolerates an absent payload', () => {
    expect(narrateFrame('search', undefined)).toEqual({ kind: 'searching' });
  });
});

describe('the enumeration is a SNAPSHOT, and says so', () => {
  it('holds the kinds motir-ai emitted at the sweep', () => {
    // ⚠️ A CROSS-REPO FIXTURE, and its limits are worth stating rather than
    // implying. It records WHAT WAS SWEPT so a reader can re-run the grep in the
    // header of `planChangeFrames.ts` and diff; it does NOT read `motir-ai`, so
    // it cannot fail when that repo adds a frame tomorrow. The mechanism that
    // covers the future is the LOUD default above — this only pins provenance.
    expect(PLAN_CHANGE_FRAME_KINDS).toHaveLength(51);
    for (const emitted of ['retrieval', 'search', 'drill', 'lay', 'author', 'note', 'planned']) {
      expect(isKnownFrameKind(emitted), emitted).toBe(true);
    }
  });

  it('the SHOW set is the story’s own sentence', () => {
    // "searching, reading code, laying a level, authoring a card, drilling …
    // and the planner's own prose line" — MOTIR-4054's description.
    const shown = PLAN_CHANGE_FRAME_KINDS.filter((k) => 'show' in FRAME_DISPOSITIONS[k]);
    expect(shown).toEqual(
      expect.arrayContaining([
        'search',
        'retrieval',
        'lay',
        'author',
        'drill',
        'note',
        'pass',
        'planned',
        'level_complete',
        'validated',
        'validation_skipped',
      ]),
    );
    // …and it is a SMALL set out of 51. A line for every kind would make the
    // rail a log, which sheet 3 rejects in as many words.
    expect(shown.length).toBeLessThan(PLAN_CHANGE_FRAME_KINDS.length / 2);
  });
});
