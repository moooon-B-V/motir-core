// Print the `structureFingerprint` for a repository's workflows at a ref — the value
// `lib/ciFleet/fleetJobInventory.json` records beside `sha` (MOTIR-8870).
//
//   pnpm exec tsx scripts/ci-fleet/fingerprint-workflows.ts <repo-checkout> <ref>
//
// Use the SAME sha the entry records, so the digest describes what was measured.
import { execFileSync } from 'node:child_process';
import { isFingerprintedPath, workflowFingerprint } from '../../lib/ciFleet/workflowFingerprint';

const [dir, ref] = process.argv.slice(2);
if (!dir || !ref) {
  console.error('usage: fingerprint-workflows.ts <repo-checkout> <ref>');
  process.exit(2);
}

const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const paths = git('ls-tree', '-r', '--name-only', ref, '.github')
  .split('\n')
  .filter((p) => p !== '' && isFingerprintedPath(p));
const files = paths.map((path) => ({ path, text: git('show', `${ref}:${path}`) }));
process.stdout.write(`${workflowFingerprint(files)}\n`);
