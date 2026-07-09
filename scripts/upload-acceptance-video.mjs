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
import { put as putBlob } from '@vercel/blob/client';

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
  const chapters = files.find((f) => f.endsWith('chapters.json'));
  // Pin the published video + trace to the dogfood test's own directory —
  // the one containing chapters.json. Only the chaptered happy-path test
  // writes chapters, so the published artifacts are deterministically the
  // dogfood clip, not a random first-find across all test runs. If no
  // chapters.json exists (the happy-path didn't run / a red run / a
  // non-chaptered suite), fall back to any .webm / trace.zip.
  const inDog = (f, ext) =>
    f.endsWith(ext) && (!chapters || path.dirname(f) === path.dirname(chapters));
  const video = files.find((f) => inDog(f, '.webm'));
  if (!video) return null;
  return {
    video,
    trace: files.find((f) => inDog(f, 'trace.zip')) ?? null,
    chapters: chapters ?? null,
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

/** The auth headers for the publish (keyless OIDC marker + bearer, else PAT). */
function authHeadersFor(oidcToken, token) {
  return oidcToken
    ? { authorization: `Bearer ${oidcToken}`, 'x-motir-auth': 'github-oidc' }
    : { authorization: `Bearer ${token}` };
}

/** Parse the chapters sidecar into an array; a malformed file → no markers. */
function readChapters(file) {
  if (!file) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Publish the artifacts DIRECT-TO-BLOB (MOTIR-1681), so a large video never
 * streams through the ~4.5MB serverless request-body cap the old multipart POST
 * hit. Three steps: (1) mint scoped client upload tokens from the endpoint;
 * (2) `put` the video (+ trace) STRAIGHT to the private Blob store with them;
 * (3) POST only the pathnames + chapters as JSON to register the evidence.
 * Throws on any non-2xx. Auth is keyless GitHub OIDC when `oidcToken` is given
 * (the `X-Motir-Auth: github-oidc` marker + the OIDC bearer), else the
 * `integration` PAT `token`.
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
  const base = baseUrl.replace(/\/$/, '');
  const headers = authHeadersFor(oidcToken, token);
  const evidenceUrl = `${base}/api/work-items/${encodeURIComponent(storyKey)}/acceptance-evidence`;

  // 1. Mint scoped client upload tokens (one per artifact).
  const tokenRes = await fetch(`${evidenceUrl}/upload-token`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ hasTrace: Boolean(artifacts.trace) }),
  });
  if (!tokenRes.ok) {
    throw new Error(
      `Acceptance-video token mint failed: ${tokenRes.status} ${await tokenRes.text()}`,
    );
  }
  const targets = await tokenRes.json();

  // 2. Upload the artifacts DIRECTLY to the private Blob store with the tokens.
  await putBlob(targets.video.pathname, fs.readFileSync(artifacts.video), {
    access: 'private',
    token: targets.video.token,
    contentType: targets.video.contentType,
  });
  if (artifacts.trace && targets.trace) {
    await putBlob(targets.trace.pathname, fs.readFileSync(artifacts.trace), {
      access: 'private',
      token: targets.trace.token,
      contentType: targets.trace.contentType,
    });
  }

  // 3. Register the pathnames (small JSON — the bytes are already in Blob).
  const res = await fetch(evidenceUrl, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      videoPathname: targets.video.pathname,
      tracePathname: targets.trace ? targets.trace.pathname : null,
      chapters: readChapters(artifacts.chapters),
      commitSha: provenance.commitSha ?? null,
      ciRunUrl: provenance.ciRunUrl ?? null,
      producedByKey: provenance.producedByKey ?? null,
    }),
  });
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
