// Single source of the CLI version string (kept in sync with package.json's
// `version` — `test/releaseCli.test.ts` compares them, because a comment is not
// a check). Used for `--version` and for the `motir-cli/<version>` harness stamp
// a dispatch reports, which is how a Motir tenant tells agent work from human
// work.
export const CLI_VERSION = '0.2.0';
