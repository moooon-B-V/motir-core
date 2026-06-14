import { z } from 'zod';

// Shared work-item-identifier plumbing for the write tools (Subtask 7.8.5).
// `transition_status` and `add_comment` both address a work item by its
// `PROD-<n>` identifier and must resolve it the SAME way the read tools do
// (`get_work_item`): derive the project key, normalize case. Kept in one place
// so the write tools can't drift from each other on what a key means.

/** The zod field every key-addressed write tool shares. */
export const workItemKeyField = z
  .string()
  .min(1)
  .describe('The work item identifier, e.g. "PROD-7" (case-insensitive).');

/** Normalize a user-supplied identifier to its canonical upper-case form. */
export function normalizeIdentifier(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Derive the owning project key from a `PROD-7`-style identifier. */
export function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}
