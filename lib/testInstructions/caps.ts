// The size bounds of a HOW TO TEST record (Story MOTIR-4906 · Subtask MOTIR-5328).
//
// Exported as constants because THREE homes state them and must agree: the
// service that refuses an over-cap input, the `publish_test_instructions` MCP
// door whose input schema tells an agent the limits BEFORE it hits one
// (MOTIR-5331), and the design's copy for the block (MOTIR-5327). A limit
// restated as a literal in any of those drifts silently; importing it cannot.
//
// Every bound is a REFUSAL, never a truncation: a How to test cut mid-section
// reads as complete to a reviewer, which is worse than an agent being told to
// shorten it.

/** Largest rich-text `bodyMd`, in UTF-8 BYTES (32 KiB). */
export const TEST_INSTRUCTIONS_MAX_BODY_BYTES = 32 * 1024;

/** Most repository sections one run's record carries. */
export const TEST_INSTRUCTIONS_MAX_REPOS = 8;

/** Longest `previewPath`, in characters. */
export const TEST_INSTRUCTIONS_MAX_SHORT_TEXT_CHARS = 500;
