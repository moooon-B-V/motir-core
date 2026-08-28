// The personal-data EXPORT, as the `Data › Data & privacy` pane renders it
// (Story 8.4 · Subtask MOTIR-1136, over MOTIR-3701's request row).
//
// `design/settings/design-notes.md` → `Data & privacy` → DECISION 2 fixes the
// shape this DTO has to serve: *"request → background build → email notification
// → the reader RETURNS to this pane → Download mints a fresh 300 s URL on the
// click."* So the pane needs the row's STATUS, the two timestamps its copy
// interpolates, and the id the download route is addressed by — and nothing
// else. `blobPathname` and `failureReason` are deliberately absent: the first is
// a storage detail the reader never sees, and the second is written *"in
// operator terms… for the person answering that mail"* (the model's own words),
// so putting it on the wire would invite a surface to render it at the reader.
//
// ISO strings rather than `Date`s, the dominant convention in `lib/dto/`: this
// shape is read by a Server Component and handed to a client island unchanged.

/**
 * The four states a request row can be in — mirrors the `DataExportStatus`
 * Postgres enum, restated here so a consumer of the DTO layer never has to
 * import a Prisma type to render a state.
 *
 * ⚠️ THE PANE RENDERS ALL FOUR, PLUS THE NO-ROW CASE. `expired` is the value a
 * card that enumerates *"idle · preparing · ready · failed"* leaves out, and it
 * is the one state whose whole reason to exist is that the pane can *"say what
 * happened instead of showing nothing"* (the model's comment on the enum). A
 * renderer over a subset of a live enum is a partial function; this union is the
 * set a `switch` has to be total over.
 */
export type DataExportStatusDTO = 'preparing' | 'ready' | 'failed' | 'expired';

/**
 * One personal-data export request, as the pane's export card renders it.
 *
 * The pane's IDLE state is the ABSENCE of this shape (`null`) rather than a
 * fifth status: a reader who has never asked for an export has no row, and
 * modelling that as a status would put a value in the database that no build,
 * sweep or download ever writes.
 */
export interface DataExportRequestDTO {
  /** The row's id — what `/api/account/data-export/<id>/download` is addressed by. */
  id: string;
  status: DataExportStatusDTO;
  /** When the reader asked. The `preparing` copy counts from here. */
  requestedAt: string;
  /** When the archive finished building — `null` until it did, and on a failure. */
  builtAt: string | null;
  /**
   * When the archive stops being downloadable — `builtAt +
   * DATA_EXPORT_RETENTION_DAYS`, persisted at build so a later change to the
   * constant cannot move a deadline somebody has already been shown. `null`
   * until the build succeeds.
   */
  expiresAt: string | null;
}
