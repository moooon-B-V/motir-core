/**
 * The SHAPE of a proposal's `subject` — the fourth planning-rule selector
 * coordinate (Story MOTIR-5062 · MOTIR-5065).
 *
 * ⚠️ SHAPE ONLY. THIS MODULE DOES NOT KNOW THE VOCABULARY, AND THAT IS THE
 * DECISION RATHER THAN AN OMISSION.
 *
 * A member of the subject vocabulary exists iff a rule pack exists for it —
 * `prompts/plan-rules/subject-<name>.md` in `motir-meta` — and motir-ai's
 * `PACKS_BY_SUBJECT` mirrors that file set. So the vocabulary's owner is the
 * corpus, and the only place an unknown member is caught is the RESOLVER, one
 * hop past this repository.
 *
 * The cost is stated rather than hidden: a well-formed but unrecognised member
 * is ACCEPTED here and fails at the resolver. That is the correct place for it,
 * because the alternative — a closed enum in this repository — would put a
 * schema change, a migration and a platform deploy in front of every new rule
 * pack, and the value's only producer is the system that owns the list.
 *
 * ⚠️ CONTRAST WITH `targetRepoRole`, WHICH THIS DELIBERATELY DOES NOT COPY.
 * A repo role IS validated here against `PROJECT_REPO_ROLES`
 * (`lib/projectRepos/vocabulary.ts`) because that vocabulary is about the
 * PROJECT'S OWN repositories — this repository's domain. A rule-pack subject is
 * not. The two look like the same pattern and answer to different owners.
 */

/** The longest a member may be. Generous enough for a compound slug, bounded so
 *  the column cannot be used as a free-text sink. */
export const SUBJECT_MAX_LENGTH = 32;

/**
 * A lowercase slug: opens with a letter, then letters / digits / single
 * hyphens, and never closes on a hyphen.
 *
 * It matches the shape a `subject-<name>.md` FILENAME can take, which is what
 * makes it the right bound: anything this rejects could not name a pack file,
 * so it could not be a member however the corpus grows.
 */
const SUBJECT_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Is this a well-formed subject slug? Says nothing about MEMBERSHIP. */
export function isWellFormedSubject(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= SUBJECT_MAX_LENGTH && SUBJECT_PATTERN.test(value)
  );
}

/** The human half of a refusal — why this particular value was rejected. */
export function describeSubjectShape(): string {
  return (
    `A subject is a lowercase slug of at most ${SUBJECT_MAX_LENGTH} characters ` +
    '(letters, digits and single hyphens, opening with a letter) — the shape a ' +
    '`subject-<name>.md` rule-pack filename can take. Membership is NOT checked here: ' +
    'the vocabulary is the pack file set, and an unrecognised member is refused by the ' +
    "planner's own rule-pack resolver."
  );
}
