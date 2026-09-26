// The `?dialog=` value that opens the Delete organization dialog on arrival
// (Story MOTIR-6306 · MOTIR-6402) — the passwordless Sign in again round trip
// lands back on it. A plain module, not the dialog's: a value exported from a
// `'use client'` file reaches a server component as a client reference, not a
// string (the same reason `workspacesPageSize.ts` exists).
export const DELETE_ORGANIZATION_DIALOG = 'delete-organization';
