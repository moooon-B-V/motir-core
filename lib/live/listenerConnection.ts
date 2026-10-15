// The live-signal listener's connection helpers (Story MOTIR-8542 · Subtask
// MOTIR-8728).
//
// ⚠️ A COPY of `closeQuietly` from `lib/jobs/engine/notify.ts`, not an import:
// the job engine is internal to the jobs runtime, and `no-restricted-imports`
// keeps `lib/jobs/engine/**` out of everything else. The behaviour is the same
// on purpose, and so is the reason it exists.

/**
 * Close a client, swallowing whatever it throws.
 *
 * `end()` CAN REJECT on a client whose socket has already errored, which is
 * exactly the state the reconnect path finds it in. Letting that propagate would
 * turn a recovering listener into a crashed process, for a connection that is
 * being discarded anyway.
 */
export async function closeQuietly(
  client: { end: () => Promise<void> } | undefined,
): Promise<void> {
  if (!client) return;
  try {
    await client.end();
  } catch {
    // Deliberately ignored — see above.
  }
}
