import { createHash } from 'node:crypto';

// A design result's `commitSha` must be a real commit id — 7 to 64 hex
// characters (MOTIR-5620), so a fixture cannot label its publishes `sha-v1` /
// `one` / `race-a` any more. This derives a DETERMINISTIC, DISTINCT and VALID
// object id from whatever label a test wants to think in, so the tests keep
// reading the way they did while the values they send are ones the guard accepts.
export const shaFor = (label: string): string => createHash('sha1').update(label).digest('hex');
