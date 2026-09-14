// The project's BUG DESTINATION (Story MOTIR-4927).
//
// A project points at a FOLDER its filed bugs land in, or at nothing — which
// means the project ROOT, chosen (MOTIR-4934). Every project is created with a
// root folder of this name and a destination pointing at it (MOTIR-4935), and
// every project that existed before is backfilled the same way (MOTIR-4936).
//
// ⚠️ THIS IS A LABEL, NEVER A LOOKUP KEY. Nothing may find the destination by
// this name: the pointer is by id precisely so a person can rename or move the
// folder and it stays the destination. The seed and the backfill write it, and
// no read path may ever compare against it.
export const DEFAULT_BUG_FOLDER_NAME = 'Bugs';
