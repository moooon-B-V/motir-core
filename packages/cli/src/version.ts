// Single source of the CLI version string — DERIVED from package.json, not a
// second copy of it. Used for `--version` and for the `motir-cli/<version>`
// harness stamp a dispatch reports, which is how a Motir tenant tells agent
// work from human work.
//
// ⚠️ IT IS DERIVED BECAUSE A MIRROR CANNOT SURVIVE AN AUTOMATED RELEASE. This
// was a hand-maintained literal kept in step with package.json by a comment and
// then, from MOTIR-2131, by a test. That held only while a person cut releases
// and edited both. `changeset version` writes package.json and nothing else, so
// the FIRST release through the Changesets lane (MOTIR-3967) desynced them
// immediately and the test caught it — which is what the test is for, but the
// lane would hit it again on every release. Reading the number instead of
// copying it retires the trap rather than re-arming it.
//
// tsup bundles this, so the literal is inlined at build time and the published
// binary reads no file at run time.
import { version } from '../package.json';

export const CLI_VERSION: string = version;
