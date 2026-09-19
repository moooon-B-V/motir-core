import { TestInstructionsCapExceededError, TestInstructionsInvalidFieldError } from './errors';

// A publish refusal, as a PERSON'S FORM shows it (Story MOTIR-5450 · Subtask
// MOTIR-5455; `design/github/design-notes.md` §24, decision 5).
//
// ⚠️ THE WORDS ARE `publish`'s OWN. One service refuses both author kinds, so a
// second human-facing phrasing would be a second contract to keep in step — and
// the one that drifts is always the one nobody's test reads. What this module
// does is decide WHERE the sentence lands, not what it says.
//
// The design puts each refusal INLINE beside the control it is about, so the
// only translation here is from a field NAME to one of the form's two fields.
// A field the form does not have — a `repos[...]` refusal — is not swallowed: it
// lands on the form itself, where it is visible rather than silent. Since
// MOTIR-5689 the form cannot produce one, and that is exactly why it must still
// be rendered if one ever arrives.

/** Where a refusal is drawn: beside a field, or on the form. */
export type HowToTestRefusalField = 'bodyMd' | 'previewPath' | null;

export interface HowToTestRefusal {
  field: HowToTestRefusalField;
  /** `publish`'s own sentence, with no `"field" is invalid:` frame. */
  message: string;
}

/** The form's own fields — anything else is drawn on the form. */
function placeOf(field: string): HowToTestRefusalField {
  return field === 'bodyMd' || field === 'previewPath' ? field : null;
}

/**
 * Place a thrown publish refusal, or return `null` when the error is not one —
 * a caller re-throws that, because an unmapped error is a bug, not a message.
 */
export function howToTestRefusal(err: unknown): HowToTestRefusal | null {
  if (err instanceof TestInstructionsInvalidFieldError) {
    return { field: placeOf(err.field), message: err.detail };
  }
  if (err instanceof TestInstructionsCapExceededError) {
    return { field: placeOf(err.field), message: err.message };
  }
  return null;
}
