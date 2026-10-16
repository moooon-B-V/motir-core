// LOADING THE SEED'S MANIFEST INTO k6 (Story MOTIR-8538 · MOTIR-8677).
//
// Read ONCE in the init context into a SharedArray (k6 holds one copy for every
// VU), as reader records (`./readerUsers.js`). Users are assigned to VUs by
// `__VU`; when the profile asks for more reader VUs than seeded users the reuse is
// stated in a warning printed at init. Nothing here prints a cookie.

import { SharedArray } from 'k6/data';
import { readerReuseWarning, readersFromManifest } from './readerUsers.js';

/** The manifest path the seed writes by default, relative to the repository root. */
export const DEFAULT_MANIFEST_PATH = 'loadtest/.out/manifest.json';

/**
 * Load the reader records. Call in the init context, with an ABSOLUTE `path`: k6
 * resolves a relative one against this file, not the working directory. `readerVus` is the profile's
 * reader VU count, for the reuse warning.
 */
export function loadReaders(path, readerVus) {
  const readers = new SharedArray('loadtest-readers', () =>
    // `open` is k6's init-context file read.
    readersFromManifest(JSON.parse(open(path))),
  );
  const warning = readerReuseWarning(readerVus, readers.length);
  if (warning) console.warn(warning);
  return readers;
}
