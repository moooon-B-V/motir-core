// The runner FLEET's scoping seam (Story MOTIR-1916 · MOTIR-1920) — WHICH
// queued CI jobs Motir boots an ephemeral runner for.
//
// `docs/decisions/ci-minutes-allowance.md` §O fixes the rule, and it is the one
// correctness requirement the whole provisioning path is built around:
//
//   > provision ONLY for jobs whose requested labels name the Motir runner.
//   > Scope by LABEL, not by receipt of an event, and not by repository owner
//   > alone — label is the only signal that survives a repo being added to the
//   > org later.
//
// ⚠️ WHY THIS IS NOT PARANOIA. The `workflow_job` `queued` event fires for
// GitHub-HOSTED jobs too, for every repository the App is installed on. Motir's
// own `motir-core` CI is 31 jobs / 141.6 job-minutes per run (§J), all of them
// `ubuntu-latest`, all of them delivering `queued` events to this same webhook.
// A listener that provisions on "we received a queued event" would silently
// migrate Motir's own release path onto infrastructure Motir is still building
// — the precise outcome §J's scope boundary exists to prevent, arriving through
// the back door.
//
// ⚠️ AND NOT BY TENANT FLAG. `Organization.isMeta` (§4.4) and `moooon-B-V` (a
// GitHub org) are DIFFERENT AXES that happen to coincide today (§O's table).
// The listener decides whether to provision BEFORE it has any tenant context —
// and for a repo with no project row there is no tenant to look up at all — so
// the exclusion must live on the label axis, where the answer is on the payload.

/**
 * The single distinctive label Motir's fleet runners register with, and the
 * value `vars.MOTIR_RUNNER` carries on `motir-projects` (§N's portability seam:
 * `runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}`, so a repo handed to
 * its owner by MOTIR-711 falls back to GitHub-hosted with no workflow edit).
 *
 * ⚠️ THE VALUE IS CONSTRAINED, not free (§M). The shipped meter's
 * `classifyRunner` (`lib/ciMetering/runnerRates.ts`) returns on the FIRST
 * substring match, so this label MUST contain none of `ubuntu`, `linux`, `arm`,
 * `windows`, `macos`, `osx`, and must not match `N-core` / `large` / `xlarge`:
 *
 *   * a label containing `linux` would classify as the GitHub `linux_x64`
 *     family — right multiplier, WRONG attribution, and MOTIR-1923's fleet row
 *     would never be exercised;
 *   * a label containing `2-core` / `large` would classify as `unknown` and log
 *     §3.4's "unpriced runner family" warning on every fleet job forever,
 *     drowning the one signal that warning exists to give.
 *
 * `motir-runner` satisfies both constraints. §M names it explicitly.
 *
 * A CONSTANT, not configuration: the fleet's label has to agree in three places
 * that cannot negotiate at runtime — the runner's own `--no-default-labels`
 * registration (MOTIR-1921), the org variable the workflows read (MOTIR-1925 /
 * MOTIR-1926), and this gate. An env var would let them drift silently, and the
 * failure mode of drift is "no runner is ever provisioned and every job queues
 * for 24 hours", which looks like an outage rather than a misconfiguration.
 */
export const MOTIR_RUNNER_LABEL = 'motir-runner';

/**
 * Does this job's REQUESTED runner labels name the Motir fleet? The §O gate,
 * and the only question that decides whether an intent is emitted.
 *
 * Compared case-INSENSITIVELY: GitHub matches runner labels case-insensitively,
 * so `MOTIR-RUNNER` in a workflow selects the same runner as `motir-runner` and
 * must therefore reach the same verdict here — a case-sensitive gate would drop
 * a job GitHub is genuinely waiting on a Motir runner for, and that job would
 * queue until GitHub expires it.
 *
 * ANY match is enough, not every label: a job is dispatched to a runner
 * carrying ALL the labels it lists, so `runs-on: [self-hosted, motir-runner]`
 * still selects the fleet. Requiring the fleet label to be the SOLE entry would
 * refuse to provision for a workflow that is unambiguously asking for it.
 */
export function isMotirFleetJob(requestedLabels: readonly string[]): boolean {
  return requestedLabels.some((label) => label.trim().toLowerCase() === MOTIR_RUNNER_LABEL);
}
