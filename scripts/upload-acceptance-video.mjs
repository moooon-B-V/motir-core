// Acceptance-video uploader (Story MOTIR-1627 · Subtask MOTIR-1632) — the BYOK
// delivery path. After a GREEN acceptance E2E, CI runs this to POST the recorded
// video + trace + chapters to the publish endpoint (MOTIR-1631), authed by a
// Motir API token (integration scope) supplied as the `MOTIR_UPLOAD_TOKEN`
// secret. A FAILING run leaves no video, so this is a no-op — a red acceptance
// E2E publishes nothing.
//
// Env: MOTIR_UPLOAD_TOKEN (required), ACCEPTANCE_STORY_KEY (required),
//      MOTIR_BASE_URL (default https://app.motir.co),
//      ACCEPTANCE_OUTPUT_DIR (default out/playwright-output-acceptance),
//      ACCEPTANCE_PRODUCED_BY, plus GitHub's GITHUB_SHA / GITHUB_RUN_ID / … for
//      provenance. Also usable as a library: import { findArtifacts,
//      uploadAcceptanceVideo }.

/* eslint-disable no-console -- this is a CLI script; stdout is its interface. */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://app.motir.co';
const DEFAULT_OUTPUT_DIR = 'out/playwright-output-acceptance';

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

/** POST the artifacts to the publish endpoint; throws on a non-2xx response. */
export async function uploadAcceptanceVideo({
  baseUrl,
  token,
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

  const res = await fetch(
    `${baseUrl.replace(/\/$/, '')}/api/work-items/${encodeURIComponent(storyKey)}/acceptance-evidence`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form },
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
  const token = process.env['MOTIR_UPLOAD_TOKEN'];
  const storyKey = process.env['ACCEPTANCE_STORY_KEY'];
  const baseUrl = process.env['MOTIR_BASE_URL'] ?? DEFAULT_BASE_URL;
  const outputDir = process.env['ACCEPTANCE_OUTPUT_DIR'] ?? DEFAULT_OUTPUT_DIR;

  if (!token || !storyKey) {
    console.error('MOTIR_UPLOAD_TOKEN and ACCEPTANCE_STORY_KEY are required.');
    process.exit(1);
  }

  const artifacts = findArtifacts(outputDir);
  if (!artifacts) {
    console.log(
      `No acceptance video under ${outputDir} — red run or recording off; nothing to publish.`,
    );
    return;
  }

  const result = await uploadAcceptanceVideo({
    baseUrl,
    token,
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
