import { NextResponse } from 'next/server';
import { monitoringRelease } from '@/lib/monitoring/config';

// GET /api/health/release (Task MOTIR-3760) — WHICH COMMIT this deployment was
// built from, readable from outside it.
//
// ⚠️ IT REPORTS ONE FACT AND DELIBERATELY DRAWS NO CONCLUSION FROM IT. The
// question anybody actually has is "is production behind `main`?", and this route
// is not allowed to answer it: a deployment cannot be the thing that reports it
// is behind, because the state being reported on is the state of the reporter.
// The release that never happened and the machine still serving an old image both
// answer "fine" to a check that lives inside them. So the comparison — `main`'s
// head, the ancestry walk, the age arithmetic, the alarm — happens OUTSIDE, in
// `.github/workflows/deploy-freshness.yml` via
// `scripts/assert-deploy-freshness.mjs`. All this route owes it is an honest
// name for its own build.
//
// ⚠️ WHY ANY OF IT EXISTS. On 2026-08-28 a story retiring an entire job engine
// merged at 07:44:30Z, and at 11:00Z the running worker bundle still carried 278
// references to that engine — code the repository no longer had anywhere. A
// scheduled health check dead-lettered against it every night with a message
// naming a system that had been deleted. The delay was defensible; that nobody
// could SEE it was not, and no dashboard anywhere said so.
//
// ⚠️ UNAUTHENTICATED, AND THAT IS THE DECISION RATHER THAN AN OMISSION — the
// same one `/api/health/queue` records (MOTIR-3764, `permission-inventory.md`
// R57). The consumer is an external monitor whose whole job is to reach this
// while the deployment is degraded, and every credential it would carry is one
// more thing that can be wrong at three in the morning. What makes it safe here
// is even plainer than there: the payload is a commit sha of a PUBLIC
// repository, already readable by anyone at github.com/moooon-B-V/motir-core. It
// discloses nothing that is not already published.
//
// ⚠️ AND THE HTTP STATUS CARRIES THE VERDICT, so a monitor that reads nothing but
// the status code still works: 200 "I know which build I am", 503 "I do not". A
// check configured against a body it has to parse is a check that silently stops
// meaning anything when the shape moves; a status code cannot drift.
//
// The 503 arm is REACHABLE AND CORRECT for a self-hosted build: `MOTIR_RELEASE`
// is a build argument that defaults to empty (`Dockerfile`), so `docker build`
// with no arguments produces an image that honestly cannot name its commit. A
// FLY release must never answer that way — the deploy job passes
// `--build-arg MOTIR_RELEASE=$GITHUB_SHA` and the runner stage carries it
// forward precisely so it cannot — which is why the freshness check treats a 503
// as a blind read and goes red rather than shrugging.
//
// Thin transport per CLAUDE.md: ONE config read, and the mapping to a status.

/** Never cached. A cached answer about which build is running is worse than none. */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const release = monitoringRelease();
  if (!release) {
    // ⚠️ NOT A NULL INSIDE A 200. Reporting "release: null" with a success status
    // makes an image that cannot name itself look like a successful read of a
    // deployment that has no commit — and the caller's own "no data is a third
    // state" handling would never fire.
    return NextResponse.json(
      { release: null, state: 'unset' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(
    { release, state: 'known' },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
