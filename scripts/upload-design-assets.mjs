#!/usr/bin/env node
// Publish a PR's DESIGN RESULT to its work item (Story MOTIR-2664 · Subtask
// MOTIR-2668) — the CI half of the design-result pipeline, run as a step in
// `ci.yml`'s existing `design-guards` job.
//
// It is the sibling of `scripts/upload-acceptance-video.mjs` and is deliberately
// shaped like it, so the two read the same way. The one structural difference:
// its INPUT is a git DIFF, not a directory of recordings.
//
//   1. COLLECT   — the PR's changed files under `design/**`, by extension.
//   2. EXTRACT   — the changed `design-notes.md` SECTIONS (not the whole
//                  per-AREA file, which runs to 300 KB across 29 sections).
//   3. RESOLVE   — the target card from the branch ref, then the PR title.
//   4. PUBLISH   — mint upload grants → PUT each file → register.
//
// ⚠️ TWO WAYS IT EXITS 0 WITHOUT PUBLISHING, both deliberate:
//   · NO CREDENTIAL — a fork PR gets neither OIDC nor the secret. Publishing is
//     opt-in; a fork must not fail the build.
//   · NO RESOLVABLE TARGET — unlike the acceptance uploader, there is NO
//     fallback constant. A design attached to the WRONG card is worse than one
//     attached to none: it makes another card look designed when it is not, and
//     the design gate that reads it would pass on a lie.
//
// Everything else that goes wrong is a real failure and exits non-zero. There is
// no `continue-on-error` on the step (MOTIR-2499 removed one from the acceptance
// publish after it reported success for days while receipts were being lost), so
// red here means exactly one thing: a publish that should have happened did not.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_OIDC_AUDIENCE = 'motir-acceptance-video';
const NOTES_BASENAME = 'design-notes.md';

/** Run a git command and return stdout. Injectable so tests need no repo. */
export function runGit(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Parse the FIRST `<PREFIX>-<number>` work-item key from a string (a branch ref
 * or PR title — the same convention `upload-acceptance-video.mjs` and the
 * status sync parse). Null when the text carries no key.
 */
export function parseWorkItemKey(text) {
  if (!text) return null;
  const m = /\b[A-Za-z][A-Za-z0-9]*-\d+\b/.exec(String(text));
  return m ? m[0].toUpperCase() : null;
}

/**
 * Resolve the target card, in precedence:
 *   1. explicit `DESIGN_TARGET_KEY` (override / library use);
 *   2. the PR's branch ref (`DESIGN_PR_REF` — the `design/MOTIR-<id>-<slug>`
 *      branch-prefix convention);
 *   3. the PR title (`DESIGN_PR_TITLE`).
 *
 * **No fallback.** `{ key: null, source: 'none' }` means "publish nothing" — see
 * the header. Returns `{ key, source }`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ key: string | null, source: string }}
 */
export function resolveTargetKey(env = process.env) {
  const explicit = (env['DESIGN_TARGET_KEY'] ?? '').trim();
  if (explicit) return { key: explicit.toUpperCase(), source: 'explicit' };
  const fromRef = parseWorkItemKey(env['DESIGN_PR_REF']);
  if (fromRef) return { key: fromRef, source: 'branch' };
  const fromTitle = parseWorkItemKey(env['DESIGN_PR_TITLE']);
  if (fromTitle) return { key: fromTitle, source: 'title' };
  return { key: null, source: 'none' };
}

/**
 * The commit the PR's changes should be measured FROM (MOTIR-3104).
 *
 * ⚠️ NOT `DESIGN_BASE_SHA` directly, and the difference is a whole class of bug.
 * `github.event.pull_request.base.sha` is the base branch's tip when the EVENT
 * was snapshotted, while the checkout is the MERGE COMMIT — which contains
 * everything the base branch did up to the merge. Diffing the two therefore
 * reports every `design/**` change that landed on the base branch in that
 * window as if this PR had made it.
 *
 * That is not hypothetical: it fired on PR #2145, a story PR touching no design
 * file at all, because another card's design PR merged between the two moments.
 * On a `subtask/*` branch it does not even fail — it publishes ANOTHER card's
 * design onto this one, with a real evidence id under a green check.
 *
 * Resolution order, most trustworthy first:
 *
 *   1. **The merge commit's FIRST PARENT.** On a `pull_request` checkout HEAD is
 *      GitHub's merge commit: parent 1 is the base tip it was merged with,
 *      parent 2 is the PR head. Diffing parent 1 → HEAD asks exactly "what did
 *      this branch change", needs no ancestry, and is therefore safe in the
 *      depth-1 clone this job runs in — where `merge-base` may have no common
 *      history to walk.
 *   2. **`git merge-base <base> HEAD`**, for a non-merge checkout deep enough to
 *      compute one (a local run, a `push` event with history).
 *   3. **The supplied base**, the pre-MOTIR-3104 behaviour, with the caveat
 *      LOGGED rather than silent — so a surprising publish set has a stated
 *      reason in the job output instead of looking authoritative.
 *
 * @param {{ base: string, git?: (args: string[], cwd?: string) => string, cwd?: string }} args
 * @returns {{ base: string, source: 'merge-parent' | 'merge-base' | 'event-base' }}
 */
export function resolveDiffBase({ base, git = runGit, cwd = process.cwd() }) {
  try {
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD'], cwd).trim().split(/\s+/);
    // `<commit> <parent1> <parent2>` — three fields means HEAD is a merge.
    if (parents.length === 3 && parents[1]) return { base: parents[1], source: 'merge-parent' };
  } catch {
    // Fall through — an unreadable HEAD is the caller's problem, not this one's.
  }
  try {
    const mergeBase = git(['merge-base', base, 'HEAD'], cwd).trim();
    if (mergeBase) return { base: mergeBase, source: 'merge-base' };
  } catch {
    // Shallow clone with no shared history — expected, not exceptional.
  }
  return { base, source: 'event-base' };
}

/** Which asset kind a path is, or null when it is not a publishable artifact. */
export function classifyDesignPath(filePath) {
  if (filePath.endsWith('.mock.html')) return 'mock';
  if (filePath.endsWith('.png')) return 'image';
  if (path.basename(filePath) === NOTES_BASENAME) return 'note';
  return null;
}

/** The content type for an asset kind. */
export function contentTypeFor(kind) {
  if (kind === 'mock') return 'text/html';
  if (kind === 'image') return 'image/png';
  return 'text/markdown';
}

/**
 * The PR's changed files under `design/**`, classified. A path that still exists
 * in the working tree is publishable; one the PR DELETED is reported separately
 * and publishes nothing.
 *
 * @param {{
 *   base: string,
 *   git?: (args: string[], cwd?: string) => string,
 *   exists?: (p: string) => boolean,
 *   cwd?: string,
 * }} args
 */
export function collectChangedDesignFiles({
  base,
  git = runGit,
  exists = (p) => fs.existsSync(p),
  cwd = process.cwd(),
} = {}) {
  const out = git(['diff', '--name-only', base, 'HEAD', '--', 'design/**'], cwd);
  const changed = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const assets = [];
  const notes = [];
  const ignored = [];
  const deleted = [];
  for (const filePath of changed) {
    if (!exists(path.join(cwd, filePath))) {
      deleted.push(filePath);
      continue;
    }
    const kind = classifyDesignPath(filePath);
    if (kind === null) ignored.push(filePath);
    else if (kind === 'note') notes.push(filePath);
    else assets.push({ kind, sourcePath: filePath });
  }
  return { assets, notes, ignored, deleted };
}

/**
 * The NEW-side line ranges a diff touched in one file. `@@ -a,b +c,d @@` → the
 * range `[c, c + max(d, 1) - 1]`; a pure deletion (`d === 0`) is reported as the
 * single line it happened at, so it still maps to a section.
 */
export function parseHunkRanges(diffText) {
  const ranges = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m;
  while ((m = re.exec(diffText)) !== null) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    ranges.push({ start: Math.max(start, 1), end: Math.max(start + Math.max(count, 1) - 1, 1) });
  }
  return ranges;
}

/**
 * Split a `design-notes.md` into its `##` sections. Returns
 * `{ startLine, endLine, text }` per section, 1-based and inclusive.
 *
 * `###` is NOT a boundary — subsections travel with their parent, which is what
 * makes a published note a whole surface description rather than a fragment.
 * Everything ABOVE the first `##` (the file title and the surface index table)
 * is deliberately NOT a section: see `extractChangedNoteSections`.
 */
export function splitNoteSections(content) {
  const lines = content.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (line.startsWith('## ')) starts.push(i + 1);
  });
  return starts.map((startLine, i) => {
    const endLine = i + 1 < starts.length ? starts[i + 1] - 1 : lines.length;
    return { startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n') };
  });
}

/**
 * The design NOTE for this publish: the `##` section(s) the PR changed, whole,
 * de-duplicated, in file order.
 *
 * ⚠️ ONE hunk can touch MANY sections, and EVERY one of them is published
 * (MOTIR-3145). The near-total case is a notes file the PR ADDED: `git diff -U0`
 * renders it as a single `@@ -0,0 +1,N @@` hunk covering the whole file, so a
 * range→section mapping that stopped at the first overlap collapsed a 25-section
 * deliverable to its opening section — worst exactly on the card whose
 * deliverable IS the note.
 *
 * ⚠️ A hunk landing ABOVE the first `##` — in the file title or the surface
 * index table — contributes NOTHING. That region is an INDEX, and a design card
 * that adds a surface always adds both a table row and the section describing
 * it, so the section carries the meaning. If a PR changed ONLY that region, this
 * returns `{ noteMd: null, reason: 'above-first-section' }` rather than falling
 * back to the whole file (docs/decisions/design-result.md §1). Sections tile the
 * file contiguously from the first `##` to EOF, so a range matching NO section is
 * exactly a range above the first one.
 */
export function extractChangedNoteSections({
  notePath,
  base,
  git = runGit,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  cwd = process.cwd(),
}) {
  const diff = git(['diff', '-U0', base, 'HEAD', '--', notePath], cwd);
  const ranges = parseHunkRanges(diff);
  if (ranges.length === 0) return { noteMd: null, reason: 'no-hunks', sections: 0 };

  const content = readFile(path.join(cwd, notePath));
  const sections = splitNoteSections(content);
  if (sections.length === 0) return { noteMd: null, reason: 'no-sections', sections: 0 };

  const touched = new Set();
  let aboveFirst = false;
  for (const range of ranges) {
    let matched = false;
    sections.forEach((section, index) => {
      if (range.end >= section.startLine && range.start <= section.endLine) {
        touched.add(index);
        matched = true;
      }
    });
    if (!matched) aboveFirst = true;
  }

  if (touched.size === 0) {
    return { noteMd: null, reason: aboveFirst ? 'above-first-section' : 'no-match', sections: 0 };
  }

  const ordered = [...touched].sort((a, b) => a - b);
  return {
    noteMd: ordered.map((i) => sections[i].text).join('\n\n'),
    reason: 'ok',
    sections: ordered.length,
  };
}

/**
 * Request a GitHub Actions OIDC token for the keyless publish. GitHub injects
 * `ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN` into a step whose job has
 * `permissions: id-token: write`; we exchange them for a JWT scoped to the Motir
 * audience. Null when NOT running under `id-token: write` (a fork PR, which
 * GitHub denies OIDC) — the caller then falls back to the PAT.
 *
 * @param {string} [audience]
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<string | null>}
 */
export async function requestGithubOidcToken(audience = DEFAULT_OIDC_AUDIENCE, env = process.env) {
  const url = env['ACTIONS_ID_TOKEN_REQUEST_URL'];
  const requestToken = env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
  if (!url || !requestToken) return null;
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${requestToken}` },
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body && typeof body.value === 'string' ? body.value : null;
}

/** The auth headers for the publish (keyless OIDC marker + bearer, else PAT). */
export function authHeadersFor(oidcToken, token) {
  return oidcToken
    ? { authorization: `Bearer ${oidcToken}`, 'x-motir-auth': 'github-oidc' }
    : { authorization: `Bearer ${token}` };
}

/**
 * The target resolved to a CONTAINER (a story or an epic), which the service
 * refuses with `DESIGN_EVIDENCE_NOT_A_LEAF`.
 *
 * ⚠️ THIS IS A NO-OP, NOT A FAILURE, and the distinction is the one the step's
 * "no `continue-on-error`" note draws: red means "a publish that should have
 * happened and did not". A design result addressed to a story is a publish that
 * must NEVER happen — the same class as "no resolvable target card", which this
 * script already exits 0 on. It is reachable on any PR whose branch or title
 * names a container and whose diff happens to touch `design/**`: the PARENT-RUN
 * pull request (`parent/MOTIR-<story>-…`), which carries a design child's asset
 * amendments alongside the code they document (MOTIR-3009). Failing there tells
 * the operator to remove a correct amendment to satisfy a publisher that had
 * nothing to publish.
 */
export class NotALeafError extends Error {
  /** @param {string} targetKey @param {string} body */
  constructor(targetKey, body) {
    super(`${targetKey} is not a leaf; a design result attaches to the card that produced it`);
    this.name = 'NotALeafError';
    this.targetKey = targetKey;
    this.body = body;
  }
}

/**
 * Mint grants, PUT every artifact, then register the result. Returns the
 * registered evidence.
 *
 * The note ships TWICE and both are required: inline as `noteMd` (what the panel
 * renders, capped server-side at 64 KiB) and as a `note_file` asset carrying the
 * COMPLETE text — which is what makes that cap a rendering bound rather than a
 * data-loss bound. When a PR changed notes in more than one area there is a
 * `note_file` PER AREA, each carrying its own `text`; `noteMd` is their
 * concatenation, so the union of the files is still the complete note.
 */
export async function publishDesignResult({
  baseUrl,
  targetKey,
  assets,
  noteMd,
  headers,
  commitSha = null,
  ciRunUrl = null,
  producedByKey = null,
  readFileBuffer = (p) => fs.readFileSync(p),
  fetchImpl = fetch,
  cwd = process.cwd(),
}) {
  const files = assets.map((a) => ({
    kind: a.kind,
    sourcePath: a.sourcePath,
    contentType: contentTypeFor(a.kind),
  }));
  // A `note_file` carries its OWN extracted text; `noteMd` is the fallback for a
  // caller that passed a single note without one (and the single-note case makes
  // the two identical anyway).
  const noteTextBySourcePath = new Map(
    assets
      .filter((a) => a.kind === 'note_file' && typeof a.text === 'string')
      .map((a) => [a.sourcePath, a.text]),
  );

  const mintRes = await fetchImpl(
    `${baseUrl}/api/work-items/${targetKey}/design-evidence/upload-token`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
    },
  );
  if (!mintRes.ok) {
    const body = await mintRes.text();
    // The service refuses a design result addressed to a CONTAINER — a result
    // attaches to the leaf that produced it, never to a story or an epic. That
    // is not a failed publish, it is a publish that must not happen; see the
    // `NotALeafError` note in the header for why it exits 0.
    if (mintRes.status === 422 && body.includes('DESIGN_EVIDENCE_NOT_A_LEAF')) {
      throw new NotALeafError(targetKey, body);
    }
    throw new Error(`Minting upload grants failed: ${mintRes.status} ${body}`);
  }
  const { targets } = await mintRes.json();

  for (const target of targets) {
    const body =
      target.kind === 'note_file'
        ? Buffer.from(noteTextBySourcePath.get(target.sourcePath) ?? noteMd ?? '', 'utf8')
        : readFileBuffer(path.join(cwd, target.sourcePath));
    const put = await fetchImpl(target.token, {
      method: 'PUT',
      headers: { 'content-type': target.contentType },
      body,
    });
    if (!put.ok) {
      throw new Error(`Uploading ${target.sourcePath} failed: ${put.status}`);
    }
  }

  const registerRes = await fetchImpl(`${baseUrl}/api/work-items/${targetKey}/design-evidence`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      assets: targets.map((t) => ({
        kind: t.kind,
        sourcePath: t.sourcePath,
        pathname: t.pathname,
      })),
      noteMd,
      commitSha,
      ciRunUrl,
      producedByKey,
    }),
  });
  if (!registerRes.ok) {
    throw new Error(
      `Registering the design result failed: ${registerRes.status} ${await registerRes.text()}`,
    );
  }
  return (await registerRes.json()).evidence;
}

/**
 * Assemble the publish set from a diff: the changed artifacts plus, for EVERY
 * `design-notes.md` whose sections the PR changed, that note in BOTH its forms.
 *
 * ⚠️ EVERY note, not the first (MOTIR-3145). A PR that touches two areas
 * legitimately describes two surfaces and the card is where both belong. The
 * inline `noteMd` — what the panel renders, capped server-side — is the notes
 * CONCATENATED in collection order; each note additionally ships as its OWN
 * `note_file` asset carrying only its own text, so `sourcePath` stays a true
 * statement about the bytes behind it and the cap stays a rendering bound.
 *
 * @param {{
 *   collected: { assets: Array<{ kind: string, sourcePath: string }> },
 *   noteResults?: Array<{ noteMd: string | null, notePath: string }>,
 * }} args
 */
export function buildPublishSet({ collected, noteResults = [] }) {
  const published = noteResults.filter((r) => r?.noteMd);
  /** @type {Array<{ kind: string, sourcePath: string, text?: string }>} */
  const assets = [...collected.assets];
  for (const result of published) {
    assets.push({ kind: 'note_file', sourcePath: result.notePath, text: result.noteMd });
  }
  return {
    assets,
    noteMd: published.length > 0 ? published.map((r) => r.noteMd).join('\n\n') : null,
  };
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {{ log: (message: string) => void }} [log]
 * @param {Record<string, any>} [deps]
 * @returns {Promise<number>}
 */
export async function main(env = process.env, log = console, deps = {}) {
  const {
    collect = collectChangedDesignFiles,
    extractNote = extractChangedNoteSections,
    resolveBase = resolveDiffBase,
    requestOidc = requestGithubOidcToken,
    publish = publishDesignResult,
  } = deps;
  const baseSha = (env['DESIGN_BASE_SHA'] ?? '').trim();
  if (!baseSha) {
    log.log('No DESIGN_BASE_SHA — nothing to diff against; nothing to publish.');
    return 0;
  }

  // MOTIR-3104: measure from where this BRANCH diverged, never from the event's
  // base snapshot — see `resolveDiffBase`. The source is logged because an
  // `event-base` fallback means the publish set may include the base branch's
  // own design changes, and a reader deserves to know that before believing it.
  const { base: diffBase, source: diffBaseSource } = resolveBase({ base: baseSha });
  if (diffBaseSource === 'event-base') {
    log.log(
      `Could not resolve a merge base; diffing against DESIGN_BASE_SHA directly. ` +
        `The publish set may include design changes made on the base branch.`,
    );
  }

  const collected = collect({ base: diffBase });
  if (collected.ignored.length > 0) {
    log.log(`Ignoring ${collected.ignored.length} non-artifact path(s) under design/.`);
  }
  if (collected.deleted.length > 0) {
    log.log(`${collected.deleted.length} design path(s) were deleted by this PR; not published.`);
  }

  // EVERY collected note is examined and every note that yields a section is
  // published (MOTIR-3145). A `break` here used to end the loop on the first
  // success, which both dropped later areas AND made the omission branch below
  // unreachable — so a second area's note vanished with no log line at all,
  // indistinguishable in the job output from a PR that only touched one area.
  const noteResults = [];
  for (const notePath of collected.notes) {
    const extracted = extractNote({ notePath, base: diffBase });
    if (extracted.noteMd) {
      noteResults.push({ ...extracted, notePath });
      log.log(`Design note: ${extracted.sections} changed section(s) from ${notePath}.`);
      continue;
    }
    log.log(
      extracted.reason === 'above-first-section'
        ? `${notePath} changed above the first section — no surface described; note omitted.`
        : `${notePath} yielded no publishable section (${extracted.reason}).`,
    );
  }

  const { assets, noteMd } = buildPublishSet({ collected, noteResults });
  if (assets.length === 0) {
    log.log('Nothing to publish — this PR changed no design artifact.');
    return 0;
  }

  const { key: targetKey, source } = resolveTargetKey(env);
  if (!targetKey) {
    // Deliberate: guessing the card would attach one card's design to another's.
    log.log(
      `No MOTIR key in the branch ref or PR title — NOT publishing. Would have published: ${assets
        .map((a) => `${a.kind}:${a.sourcePath}`)
        .join(', ')}`,
    );
    return 0;
  }

  const oidcToken = await requestOidc(env['MOTIR_OIDC_AUDIENCE'] ?? DEFAULT_OIDC_AUDIENCE, env);
  const patToken = (env['MOTIR_UPLOAD_TOKEN'] ?? '').trim();
  if (!oidcToken && !patToken) {
    log.log('No OIDC identity and no MOTIR_UPLOAD_TOKEN — publishing is opt-in; skipping.');
    return 0;
  }

  const baseUrl = (env['MOTIR_BASE_URL'] ?? 'https://app.motir.co').replace(/\/$/, '');
  let evidence;
  try {
    evidence = await publish({
      baseUrl,
      targetKey,
      assets,
      noteMd,
      headers: authHeadersFor(oidcToken, patToken),
      commitSha: env['GITHUB_SHA'] ?? null,
      ciRunUrl:
        env['GITHUB_SERVER_URL'] && env['GITHUB_REPOSITORY'] && env['GITHUB_RUN_ID']
          ? `${env['GITHUB_SERVER_URL']}/${env['GITHUB_REPOSITORY']}/actions/runs/${env['GITHUB_RUN_ID']}`
          : null,
      producedByKey: targetKey,
    });
  } catch (err) {
    if (!(err instanceof NotALeafError)) throw err;
    // See NotALeafError: a container-addressed result is a publish that must not
    // happen, which is the same exit as an unresolvable target — reported, not red.
    log.log(
      `${targetKey} is a CONTAINER, not the card that produced these assets — NOT publishing. ` +
        `The design child's own pull request is what publishes them. Would have published: ${assets
          .map((a) => `${a.kind}:${a.sourcePath}`)
          .join(', ')}`,
    );
    return 0;
  }

  log.log(
    `Published ${assets.length} design artifact(s) to ${targetKey} (target from ${source}); evidence ${evidence.id}.`,
  );
  return 0;
}

// `node scripts/upload-design-assets.mjs` runs it; an import (the tests) does not.
if (process.argv[1] && process.argv[1].endsWith('upload-design-assets.mjs')) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`::error::Design-result publish failed: ${err?.message ?? err}`);
      process.exit(1);
    });
}
