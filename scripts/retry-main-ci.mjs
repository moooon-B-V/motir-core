#!/usr/bin/env node
/**
 * Re-attempt a red or cancelled push-to-`main` CI run — at most once, visibly
 * (MOTIR-4607).
 *
 * Called by `.github/workflows/main-ci-retry.yml` on `workflow_run: completed`:
 *
 *   RUN_ID=<id> GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/name node scripts/retry-main-ci.mjs
 *
 * WHAT IT DECIDES, and why the bound cannot loop: see `scripts/mainCiRetry.mjs`,
 * which holds every decision and is the file with the tests. This runner does
 * the I/O only — read the run and `main`, POST the re-run, poll it to completion,
 * raise the signal, print.
 *
 * ⚠️ IT WAITS FOR ITS OWN RE-RUN RATHER THAN RELYING ON BEING CALLED AGAIN. The
 * obvious shape is to let the attempt-2 `workflow_run` event call this lane a
 * second time and raise the signal then. That rests on a claim no document read
 * for this card settles: whether a re-run REQUESTED by `GITHUB_TOKEN` delivers a
 * `workflow_run` event at all (GitHub's rule is that `GITHUB_TOKEN`-triggered
 * events "do not create workflow runs", with named exceptions). If it does not,
 * the failed-twice signal would never fire — the silent shape this card exists to
 * remove. So the lane that made the re-run follows it to the end, and an
 * attempt-2 event, if one arrives, is a SKIP (`decideRetry`'s attempt bound).
 * Either way the signal fires exactly once and nothing can re-trigger.
 *
 * ENV: `RUN_ID`, `GITHUB_TOKEN`, `GITHUB_REPOSITORY` (required); `GITHUB_API_URL`,
 * `GITHUB_STEP_SUMMARY`, `POLL_SECONDS` (30),
 * `DEADLINE_MINUTES` (75) — optional.
 *
 * EXIT CODES: 0 skipped / recovered / superseded · 1 failed twice (signal raised)
 * · 2 usage · 3 blind (an API read failed, or the re-run did not finish in time).
 */
/* eslint-disable no-console -- this is a CLI script; stdout is its interface. */
import { appendFileSync } from 'node:fs';
import {
  EXIT_BLIND,
  EXIT_FAILED_TWICE,
  EXIT_OK,
  EXIT_USAGE,
  SIGNAL_LABEL,
  decideRetry,
  issueBody,
  issueTitle,
  judgeRetry,
} from './mainCiRetry.mjs';

const env = process.env;
const API = (env['GITHUB_API_URL'] || 'https://api.github.com').replace(/\/$/, '');
const REPO = env['GITHUB_REPOSITORY'] ?? '';
const TOKEN = env['GITHUB_TOKEN'] ?? '';
const RUN_ID = env['RUN_ID'] ?? '';
const POLL_SECONDS = Number(env['POLL_SECONDS'] || 30);
const DEADLINE_MINUTES = Number(env['DEADLINE_MINUTES'] || 75);

const summary = [];
const report = (line) => {
  console.log(line);
  summary.push(line);
};

async function gh(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = new Error(
      `${method} ${path} → ${res.status} ${json?.message ?? text.slice(0, 200)}`,
    );
    error.status = res.status;
    throw error;
  }
  return json;
}

const readRun = () => gh('GET', `/repos/${REPO}/actions/runs/${RUN_ID}`);
const readMainHead = async () => (await gh('GET', `/repos/${REPO}/branches/main`)).commit.sha;

const view = (run, mainHeadSha) => ({
  workflowName: run.name,
  event: run.event,
  headBranch: run.head_branch,
  conclusion: run.conclusion,
  runAttempt: run.run_attempt,
  headSha: run.head_sha,
  mainHeadSha,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function raiseSignal(run, firstConclusion) {
  const title = issueTitle(run.head_sha);
  const body = issueBody({
    runUrl: run.html_url,
    headSha: run.head_sha,
    firstConclusion,
    secondConclusion: run.conclusion,
    actor: run.actor?.login ?? 'unknown',
  });
  // The label may not exist yet; 422 means it already does.
  try {
    await gh('POST', `/repos/${REPO}/labels`, {
      name: SIGNAL_LABEL,
      color: 'd73a4a',
      description: 'A push-to-main CI run failed on its automatic re-attempt (MOTIR-4607)',
    });
  } catch (error) {
    if (error.status !== 422) throw error;
  }
  const open = await gh(
    'GET',
    `/repos/${REPO}/issues?state=open&labels=${SIGNAL_LABEL}&per_page=100`,
  );
  const existing = (open ?? []).find((issue) => issue.title === title);
  if (existing) {
    await gh('POST', `/repos/${REPO}/issues/${existing.number}/comments`, { body });
    return existing.html_url;
  }
  const issue = { title, body, labels: [SIGNAL_LABEL] };
  try {
    // Assigned to whoever merged, so the notification lands on a person who has
    // a reason to open it — a red check on `main` is nobody's by construction.
    const created = await gh('POST', `/repos/${REPO}/issues`, {
      ...issue,
      assignees: run.actor?.login ? [run.actor.login] : [],
    });
    return created.html_url;
  } catch (error) {
    if (error.status !== 422) throw error;
    // An actor who cannot be assigned (a bot, an outside collaborator) must not
    // cost the signal itself.
    return (await gh('POST', `/repos/${REPO}/issues`, issue)).html_url;
  }
}

async function main() {
  if (!RUN_ID || !REPO || !TOKEN) {
    console.error('::error::RUN_ID, GITHUB_REPOSITORY and GITHUB_TOKEN are required');
    return EXIT_USAGE;
  }

  let run;
  let mainHeadSha;
  try {
    [run, mainHeadSha] = await Promise.all([readRun(), readMainHead()]);
  } catch (error) {
    console.error(`::error::Could not read the run or main: ${error.message}`);
    return EXIT_BLIND;
  }

  report(`run: ${run.html_url} (attempt ${run.run_attempt}, ${run.conclusion})`);
  const decision = decideRetry(view(run, mainHeadSha));
  report(`decision: ${decision.action} — ${decision.reason}`);
  if (decision.action === 'skip') return EXIT_OK;

  const firstConclusion = run.conclusion;
  const endpoint = decision.mode === 'all' ? 'rerun' : 'rerun-failed-jobs';
  try {
    await gh('POST', `/repos/${REPO}/actions/runs/${RUN_ID}/${endpoint}`);
  } catch (error) {
    console.error(`::error::Could not re-run ${run.html_url}: ${error.message}`);
    return EXIT_BLIND;
  }
  // The re-attempt is ALSO visible on the run itself: GitHub labels it
  // "Attempt #2", re-run by `github-actions[bot]`.
  console.log(
    `::notice title=CI on main re-attempted::${endpoint} on ${run.html_url} — attempt 2 is automatic (MOTIR-4607)`,
  );
  report(`re-attempt: POST ${endpoint} — waiting for attempt 2 to finish`);

  const deadline = Date.now() + DEADLINE_MINUTES * 60_000;
  for (;;) {
    await sleep(POLL_SECONDS * 1000);
    let polled = true;
    try {
      run = await readRun();
    } catch (error) {
      // A transient read failure is retried — but still inside the deadline.
      console.log(`poll: ${error.message} — retrying`);
      polled = false;
    }
    if (polled && run.run_attempt > 1 && run.status === 'completed') break;
    if (Date.now() > deadline) {
      console.error(
        `::error::Attempt 2 of ${run.html_url} did not finish within ${DEADLINE_MINUTES} minutes ` +
          `(attempt ${run.run_attempt}, ${run.status}). Its verdict is unknown — read the run.`,
      );
      return EXIT_BLIND;
    }
  }

  try {
    mainHeadSha = await readMainHead();
  } catch (error) {
    console.error(`::error::Could not re-read main: ${error.message}`);
    return EXIT_BLIND;
  }
  const verdict = judgeRetry(view(run, mainHeadSha));
  report(`outcome: ${verdict.outcome} — ${verdict.reason}`);
  if (verdict.outcome !== 'failed-twice') return EXIT_OK;

  try {
    const url = await raiseSignal(run, firstConclusion);
    report(`signal: ${url}`);
    console.error(`::error::CI on main failed twice at ${run.head_sha} — ${url}`);
  } catch (error) {
    console.error(
      `::error::CI on main failed twice at ${run.head_sha}, and the issue could not be opened: ${error.message}`,
    );
  }
  return EXIT_FAILED_TWICE;
}

const code = await main();
if (env['GITHUB_STEP_SUMMARY']) {
  appendFileSync(
    env['GITHUB_STEP_SUMMARY'],
    ['### CI on main — automatic re-attempt', '', '```', ...summary, '```', ''].join('\n'),
  );
}
process.exit(code);
