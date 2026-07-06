// Acceptance-video uploader (Story MOTIR-1627 · Subtask MOTIR-1632; keyless auth
// MOTIR-1650) — the BYOK delivery path. After a GREEN acceptance E2E, CI runs
// this to POST the recorded video + trace + chapters to the publish endpoint
// (MOTIR-1631). Auth is KEYLESS GitHub OIDC first (a repo connected via the
// Motir GitHub App needs NO secret — the job's `id-token: write` OIDC identity
// resolves the workspace), falling back to a `MOTIR_UPLOAD_TOKEN` PAT
// (`integration` scope) for an unconnected repo. A FAILING run leaves no video,
// so this is a no-op — a red acceptance E2E publishes nothing.
//
// Env: ACCEPTANCE_STORY_KEY (required); auth is EITHER a GitHub OIDC token (auto
//      via `id-token: write` — `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN`) OR
//      MOTIR_UPLOAD_TOKEN (the PAT fallback) — neither present → opt-in no-op;
//      MOTIR_OIDC_AUDIENCE (default motir-acceptance-video),
//      MOTIR_BASE_URL (default https://app.motir.co),
//      ACCEPTANCE_OUTPUT_DIR (default out/playwright-output-acceptance),
//      ACCEPTANCE_PRODUCED_BY, plus GitHub's GITHUB_SHA / GITHUB_RUN_ID / … for
//      provenance. Also usable as a library: import { findArtifacts,
//      requestGithubOidcToken, uploadAcceptanceVideo }.

/* eslint-disable no-console -- this is a CLI script; stdout is its interface. */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://app.motir.co';
const DEFAULT_OUTPUT_DIR = 'out/playwright-output-acceptance';
const DEFAULT_OIDC_AUDIENCE = 'motir-acceptance-video';

/**
 * Walk a Playwright output dir and locate the acceptance artifacts. Returns null
 * when there is NO video (a failed/aborted run recorded none) — the caller then
 * publishes nothing. `trace` / `chapters` are optional.
 */
export function findArtifacts(outputDir) {
  if (!fs.existsSync(outputDir)) return null;
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  const files = walk(outputDir);
  const video = files.find((f) => f.endsWith('.webm'));
  if (!video) return null;
  return {
    video,
    trace: files.find((f) => f.endsWith('trace.zip')) ?? null,
    chapters: files.find((f) => f.endsWith('chapters.json')) ?? null,
  };
}

/**
 * Request a GitHub Actions OIDC token for the keyless publish (MOTIR-1650).
 * GitHub injects `ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN` into a step whose job
 * has `permissions: id-token: write`; we exchange them for a JWT scoped to the
 * Motir audience. Returns null when NOT running under id-token: write (e.g. a
 * fork PR, which GitHub denies OIDC) — the caller then falls back to the PAT.
 */
export async function requestGithubOidcToken(audience = DEFAULT_OIDC_AUDIENCE) {
  const url = process.env['ACTIONS_ID_TOKEN_REQUEST_URL'];
  const requestToken = process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
  if (!url || !requestToken) return null;
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${requestToken}` },
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body && typeof body.value === 'string' ? body.value : null;
}

/**
 * POST the artifacts to the publish endpoint; throws on a non-2xx response.
 * Auth is keyless GitHub OIDC when `oidcToken` is given (the `X-Motir-Auth:
 * github-oidc` marker + the OIDC bearer), else the `integration` PAT `token`.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string | null} [opts.token] - the `integration` PAT (fallback auth)
 * @param {string | null} [opts.oidcToken] - a GitHub OIDC token (keyless auth)
 * @param {string} opts.storyKey
 * @param {{ video: string, trace: string | null, chapters: string | null }} opts.artifacts
 * @param {{ commitSha?: string | null, ciRunUrl?: string | null, producedByKey?: string | null }} [opts.provenance]
 */
export async function uploadAcceptanceVideo({
  baseUrl,
  token = null,
  oidcToken = null,
  storyKey,
  artifacts,
  provenance = {},
}) {
  const form = new FormData();
  form.set(
    'video',
    new Blob([fs.readFileSync(artifacts.video)], { type: 'video/webm' }),
    'acceptance.webm',
  );
  if (artifacts.trace) {
    form.set(
      'trace',
      new Blob([fs.readFileSync(artifacts.trace)], { type: 'application/zip' }),
      'trace.zip',
    );
  }
  if (artifacts.chapters) form.set('chapters', fs.readFileSync(artifacts.chapters, 'utf8'));
  if (provenance.commitSha) form.set('commitSha', provenance.commitSha);
  if (provenance.ciRunUrl) form.set('ciRunUrl', provenance.ciRunUrl);
  if (provenance.producedByKey) form.set('producedByKey', provenance.producedByKey);

  const headers = oidcToken
    ? { authorization: `Bearer ${oidcToken}`, 'x-motir-auth': 'github-oidc' }
    : { authorization: `Bearer ${token}` };
  const res = await fetch(
    `${baseUrl.replace(/\/$/, '')}/api/work-items/${encodeURIComponent(storyKey)}/acceptance-evidence`,
    { method: 'POST', headers, body: form },
  );
  if (!res.ok) {
    throw new Error(`Acceptance-video publish failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function ciRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
    ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
    : null;
}

async function main() {
  const storyKey = process.env['ACCEPTANCE_STORY_KEY'];
  const baseUrl = process.env['MOTIR_BASE_URL'] ?? DEFAULT_BASE_URL;
  const outputDir = process.env['ACCEPTANCE_OUTPUT_DIR'] ?? DEFAULT_OUTPUT_DIR;
  const audience = process.env['MOTIR_OIDC_AUDIENCE'] ?? DEFAULT_OIDC_AUDIENCE;

  if (!storyKey) {
    console.error('ACCEPTANCE_STORY_KEY is required.');
    process.exit(1);
  }

  const artifacts = findArtifacts(outputDir);
  if (!artifacts) {
    console.log(
      `No acceptance video under ${outputDir} — red run or recording off; nothing to publish.`,
    );
    return;
  }

  // Keyless GitHub OIDC first (MOTIR-1650); fall back to the MOTIR_UPLOAD_TOKEN
  // PAT for a repo not connected via the App. Neither present → opt-in no-op
  // (a fork PR gets no OIDC and no secret, so it never fails here).
  const oidcToken = await requestGithubOidcToken(audience);
  const token = process.env['MOTIR_UPLOAD_TOKEN'] || null;
  if (!oidcToken && !token) {
    console.log(
      'No GitHub OIDC token (needs id-token: write) and no MOTIR_UPLOAD_TOKEN — skipping the publish (BYOK is opt-in).',
    );
    return;
  }
  console.log(
    oidcToken
      ? 'Authenticating the acceptance-video publish via keyless GitHub OIDC.'
      : 'Authenticating the acceptance-video publish via MOTIR_UPLOAD_TOKEN (PAT fallback).',
  );

  const result = await uploadAcceptanceVideo({
    baseUrl,
    token,
    oidcToken,
    storyKey,
    artifacts,
    provenance: {
      commitSha: process.env['GITHUB_SHA'] ?? null,
      ciRunUrl: ciRunUrl(),
      producedByKey: process.env['ACCEPTANCE_PRODUCED_BY'] ?? null,
    },
  });
  console.log(`Published acceptance evidence for ${storyKey}: ${result?.evidence?.id ?? 'ok'}`);
}

// Run only when invoked as a script (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith('upload-acceptance-video.mjs')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
