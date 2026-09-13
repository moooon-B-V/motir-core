// The size bounds of a HOW TO TEST record (Story MOTIR-4906 · Subtask MOTIR-5328).
//
// Exported as constants because THREE homes state them and must agree: the
// service that refuses an over-cap input, the `publish_test_instructions` MCP
// door whose input schema tells an agent the limits BEFORE it hits one
// (MOTIR-5331), and the design's copy for the block (MOTIR-5327). A limit
// restated as a literal in any of those drifts silently; importing it cannot.
//
// Every bound is a REFUSAL, never a truncation: a click-path cut at step 30 reads
// as complete to a reviewer, which is worse than an agent being told to shorten it.

/** Most click-path steps one record carries. */
export const TEST_INSTRUCTIONS_MAX_STEPS = 30;

/** Most repository sections one run's record carries. */
export const TEST_INSTRUCTIONS_MAX_REPOS = 8;

/** Most setup commands (install / migrate / seed / run …) one repository section carries. */
export const TEST_INSTRUCTIONS_MAX_SETUP_COMMANDS = 12;

/** Longest single click-path step, and longest setup-command LABEL, in characters. */
export const TEST_INSTRUCTIONS_MAX_STEP_CHARS = 300;

/** Longest single setup COMMAND, in characters. */
export const TEST_INSTRUCTIONS_MAX_COMMAND_CHARS = 500;

/** Longest `clickPathNotApplicableReason` and `previewPath`, in characters. */
export const TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS = 500;

/** Largest `preconditionMd`, in UTF-8 BYTES (8 KiB). */
export const TEST_INSTRUCTIONS_MAX_PRECONDITION_BYTES = 8 * 1024;
