// Fixture stand-in for the REAL `lib/workspaces/context.ts` (MOTIR-2945) — the
// blessed mid-block binder, living in a module the fixture service IMPORTS.
//
// ⚠️ THE IMPORT IS THE POINT, so this cannot be a local declaration and it
// cannot be `declare`d the way this fixture's `db` is. `bindWorkspaceContext` is
// the answer the real module documents for the one shape the `with*Context`
// wrappers cannot serve — *"the workspace is not known until partway through the
// transaction"* — and it is ALWAYS reached across a module boundary. A scan that
// followed only SAME-FILE helpers therefore could not see the one call a careful
// author is supposed to make, and reported a correctly-bound block as unbound.
//
// The path mirrors the real module's so the fixture reads as the shape it stands
// for. Nothing matches on that path: the scan resolves the IMPORT and then reads
// the declaration's body, so what makes a callee a binder is its `set_config`,
// never its name or its file.

interface Client {
  widget: { findUnique(args: unknown): Promise<unknown> };
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/** Binds `app.workspace_id` on an already-open transaction. */
export async function bindWorkspaceContext(tx: Client, workspaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
}

/**
 * THE CONTROL — an imported function that binds NOTHING. Handing it the `tx`
 * must not move `bindPos`, or "reaches an imported callee" would quietly become
 * "is bound", which is the permissive mirror of the defect this fixture pins.
 */
export async function touchWorkspace(tx: Client, id: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "workspace" WHERE id = ${id}`;
}
