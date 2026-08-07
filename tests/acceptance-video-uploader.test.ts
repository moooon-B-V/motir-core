import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The client-direct upload (MOTIR-1681) is an ordinary PUT to a presigned URL
// since MOTIR-2389, so the shared `fetch` stub covers it — there is no SDK left
// to module-mock. The test asserts the mint → PUT → register orchestration.

// The BYOK uploader (Subtask MOTIR-1632; direct-to-Blob MOTIR-1681) — pure
// logic, no DB. Tests the no-op (red-run) path + the mint/upload/register flow.
import {
  assessArtifactSizes,
  assessWatchability,
  DEFAULT_MAX_ARTIFACT_BYTES,
  findRecordings,
  main,
  parseWorkItemKey,
  isOwnedRecording,
  resolveMaxArtifactBytes,
  resolveOwnedSpecs,
  resolveStoryKey,
  uploadAcceptanceVideo,
} from '../scripts/upload-acceptance-video.mjs';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acc-video-'));
}

/** A presigned PUT URL of the shape `mintPrivateUploadToken` now returns. */
function signedPutUrl(key: string): string {
  return `https://s3.example/motir-private/${key}?X-Amz-Signature=sig&X-Amz-SignedHeaders=content-type%3Bhost`;
}

/** The PUT calls a fetch mock recorded — the direct-upload half of the flow. */
function putCalls(fetchMock: { mock: { calls: unknown[][] } }): Array<{
  url: string;
  contentType: string | undefined;
  body: unknown;
}> {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'PUT')
    .map(([url, init]) => {
      const i = init as { headers?: Record<string, string>; body?: unknown };
      return { url: String(url), contentType: i.headers?.['content-type'], body: i.body };
    });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** Write one Playwright-shaped recording directory. */
function writeRecording(
  root: string,
  name: string,
  opts: {
    video?: string;
    trace?: boolean;
    chapters?: string | null;
    storyKey?: string | null;
    /** Adds `totalSeconds` to `recording-meta.json`; omit for an unpaced/legacy
     *  recording (no duration → the watchability guard abstains). */
    totalSeconds?: number;
    /** The spec that produced the recording (MOTIR-1937's ownership key).
     *  Defaults to `tests/e2e/<name>.spec.ts`; pass `null` for a LEGACY sidecar
     *  written before the field existed. */
    specFile?: string | null;
    /** Whether THIS run "changed" that spec — i.e. whether the recording is
     *  publishable (MOTIR-1937). Defaults to true so the publish cases keep
     *  asserting publishing; the ownership cases pass `false`. */
    owned?: boolean;
  } = {},
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'video.webm'), opts.video ?? 'clip');
  if (opts.trace !== false) fs.writeFileSync(path.join(dir, 'trace.zip'), 'trace');
  if (opts.chapters !== null)
    fs.writeFileSync(path.join(dir, 'chapters.json'), opts.chapters ?? '[]');
  if (opts.storyKey)
    fs.writeFileSync(
      path.join(dir, 'acceptance-story.json'),
      JSON.stringify({ storyKey: opts.storyKey }),
    );
  // `recording-meta.json` now always exists: it carries `specFile` (the
  // MOTIR-1937 ownership key) as well as the optional duration. A watchability
  // verdict still abstains when `totalSeconds` is absent.
  const specFile = opts.specFile === undefined ? specFileFor(name) : opts.specFile;
  fs.writeFileSync(
    path.join(dir, 'recording-meta.json'),
    JSON.stringify({
      ...(opts.totalSeconds !== undefined ? { totalSeconds: opts.totalSeconds } : {}),
      ...(specFile ? { specFile } : {}),
    }),
  );
  // Own it by DEFAULT — the run "changed" this spec — so every pre-existing
  // publish case keeps asserting publish behaviour rather than silently
  // asserting the gate. An ownership case opts out with `owned: false`.
  if (specFile && opts.owned !== false) {
    const current = process.env['ACCEPTANCE_CHANGED_SPECS'] ?? '';
    process.env['ACCEPTANCE_CHANGED_SPECS'] = `${current} ${specFile}`.trim();
  }
  return dir;
}

/** The spec path `writeRecording` stamps a recording with, derived from its
 *  Playwright output-dir name (`<spec>-<title>-chromium` → the spec file). */
function specFileFor(recordingDirName: string): string {
  return `tests/e2e/${recordingDirName}.spec.ts`;
}

/**
 * Force a DETERMINISTIC walk order (name-sorted), so a walk-order-dependent bug
 * is reproducible rather than at the mercy of the OS's native readdir ordering.
 * Restored by the afterEach `vi.restoreAllMocks()`.
 */
function sortReaddir(): void {
  const realReaddir = fs.readdirSync;
  vi.spyOn(fs, 'readdirSync').mockImplementation(((dirPath, options) => {
    const entries = (realReaddir as (p: unknown, o: unknown) => Array<{ name: string }>)(
      dirPath,
      options,
    );
    return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  }) as typeof fs.readdirSync);
}

describe('findRecordings', () => {
  it('returns [] when the output dir does not exist (nothing ran)', () => {
    expect(findRecordings(path.join(os.tmpdir(), 'does-not-exist-xyz'))).toEqual([]);
  });

  it('returns [] when there is no video (a red run recorded none)', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'trace.zip'), 'x');
    expect(findRecordings(dir)).toEqual([]);
  });

  it('returns EVERY chaptered recording, each with its own story (MOTIR-1734)', () => {
    // The lane as it actually stands: one chaptered acceptance spec per
    // user-facing story. Before the fix only the first (walk-order) recording
    // was published and the other two stories silently got no video.
    const dir = tmpDir();
    writeRecording(dir, 'acceptance-augment-replan-chromium', {
      video: 'replan-clip',
      storyKey: 'MOTIR-811',
    });
    writeRecording(dir, 'acceptance-plan-change-chromium', {
      video: 'plan-change-clip',
      storyKey: 'MOTIR-1726',
    });
    writeRecording(dir, 'acceptance-video-dogfood-chromium', {
      video: 'dogfood-clip',
      storyKey: 'MOTIR-1627',
    });
    sortReaddir();

    const found = findRecordings(dir);
    expect(found).toHaveLength(3);
    expect(found.map((r) => r.storyKey)).toEqual(['MOTIR-811', 'MOTIR-1726', 'MOTIR-1627']);
    // Each recording carries ITS OWN clip — never a sibling's.
    expect(found.map((r) => fs.readFileSync(r.video, 'utf8'))).toEqual([
      'replan-clip',
      'plan-change-clip',
      'dogfood-clip',
    ]);
  });

  it('pins each recording video + trace + chapters to its OWN directory (MOTIR-1680, now per recording)', () => {
    const dir = tmpDir();
    // An un-chaptered sibling sorts FIRST, so a naive "first .webm across the
    // tree" would pair the chaptered story with the sibling's clip.
    const sibling = writeRecording(dir, 'aaa-another-test-chromium', {
      video: 'other-clip',
      chapters: null,
    });
    const chaptered = writeRecording(dir, 'zzz-dogfood-happy-path-chromium', {
      video: 'dogfood-clip',
      chapters: '[{"label":"Open the story"}]',
    });
    sortReaddir();

    const found = findRecordings(dir);
    // The un-chaptered sibling is NOT published when a chaptered recording
    // exists — it is a plain test clip, not an acceptance receipt.
    expect(found).toHaveLength(1);
    expect(path.dirname(found[0]!.video)).toBe(chaptered);
    expect(path.dirname(found[0]!.trace as string)).toBe(chaptered);
    expect(path.dirname(found[0]!.chapters as string)).toBe(chaptered);
    expect(fs.readFileSync(found[0]!.video, 'utf8')).toBe('dogfood-clip');
    expect(found.some((r) => r.dir === sibling)).toBe(false);
  });

  it("ignores a test's attachments/ subdir (hash-suffixed sidecar copies, no video)", () => {
    const dir = tmpDir();
    const rec = writeRecording(dir, 'story-acceptance-flow-chromium', { storyKey: 'MOTIR-1726' });
    const attachments = path.join(rec, 'attachments');
    fs.mkdirSync(attachments);
    fs.writeFileSync(path.join(attachments, 'chapters-89b3c14d.json'), '[]');
    fs.writeFileSync(path.join(attachments, 'acceptance-story-bf3b4a31.json'), '{}');

    const found = findRecordings(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.dir).toBe(rec);
    expect(found[0]!.storyKey).toBe('MOTIR-1726');
  });

  it('falls back to a SINGLE recording when no chapters.json exists (non-chaptered suite)', () => {
    const dir = tmpDir();
    writeRecording(dir, 'aaa-some-test-chromium', { chapters: null });
    writeRecording(dir, 'zzz-other-test-chromium', { chapters: null });
    sortReaddir();

    const found = findRecordings(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.video.endsWith('.webm')).toBe(true);
    expect(found[0]!.chapters).toBeNull();
  });

  it('finds the video + trace + chapters (nested), when present', () => {
    const dir = tmpDir();
    writeRecording(dir, 'story-acceptance-flow-chromium');
    const found = findRecordings(dir);
    expect(found[0]!.video.endsWith('.webm')).toBe(true);
    expect(found[0]!.trace?.endsWith('trace.zip')).toBe(true);
    expect(found[0]!.chapters?.endsWith('chapters.json')).toBe(true);
  });

  it('reads the recording self-declared story from acceptance-story.json (MOTIR-1684)', () => {
    const dir = tmpDir();
    writeRecording(dir, 'dogfood-chromium', { storyKey: 'MOTIR-1627' });
    expect(findRecordings(dir)[0]!.storyKey).toBe('MOTIR-1627');
  });

  it('storyKey is null when no acceptance-story.json sidecar exists', () => {
    const dir = tmpDir();
    writeRecording(dir, 'dogfood-chromium');
    expect(findRecordings(dir)[0]!.storyKey).toBeNull();
  });

  it('pins the story sidecar to its own recording — a sibling cannot shadow it', () => {
    const dir = tmpDir();
    writeRecording(dir, 'aaa-sibling-chromium', {
      video: 'other',
      chapters: null,
      storyKey: 'MOTIR-9999',
    });
    writeRecording(dir, 'zzz-dogfood-chromium', { video: 'dogfood', storyKey: 'MOTIR-1627' });
    sortReaddir();

    const found = findRecordings(dir);
    expect(found).toHaveLength(1);
    expect(found[0]!.storyKey).toBe('MOTIR-1627');
  });

  it('is deterministic — recordings come back in a stable order, not the filesystem’s', () => {
    const dir = tmpDir();
    writeRecording(dir, 'ccc-chromium', { storyKey: 'MOTIR-3' });
    writeRecording(dir, 'aaa-chromium', { storyKey: 'MOTIR-1' });
    writeRecording(dir, 'bbb-chromium', { storyKey: 'MOTIR-2' });
    // NOTE: no readdir sort mock — the function must sort its own output.
    expect(findRecordings(dir).map((r) => r.storyKey)).toEqual(['MOTIR-1', 'MOTIR-2', 'MOTIR-3']);
  });
});

describe('parseWorkItemKey', () => {
  it('extracts the key from a subtask branch ref', () => {
    expect(parseWorkItemKey('subtask/MOTIR-1684-acceptance-publish')).toBe('MOTIR-1684');
  });

  it('extracts the key from a story-level PR title', () => {
    expect(parseWorkItemKey('feat(acceptance): story gate (MOTIR-1627)')).toBe('MOTIR-1627');
  });

  it('upper-cases a lower-case ref and takes the FIRST key', () => {
    expect(parseWorkItemKey('story/motir-1644-and-motir-9')).toBe('MOTIR-1644');
  });

  it('returns null for empty / keyless text', () => {
    expect(parseWorkItemKey('')).toBeNull();
    expect(parseWorkItemKey(undefined)).toBeNull();
    expect(parseWorkItemKey('main')).toBeNull();
  });
});

describe('resolveStoryKey (MOTIR-1684 precedence)', () => {
  it('1. explicit ACCEPTANCE_STORY_KEY outranks everything', () => {
    const r = resolveStoryKey('MOTIR-1627', {
      ACCEPTANCE_STORY_KEY: 'MOTIR-42',
      ACCEPTANCE_PR_REF: 'subtask/MOTIR-100-x',
      ACCEPTANCE_FALLBACK_STORY_KEY: 'MOTIR-1627',
    });
    expect(r).toEqual({ storyKey: 'MOTIR-42', source: 'explicit' });
  });

  it('2. the recording self-declared story outranks the PR-derived key', () => {
    const r = resolveStoryKey('MOTIR-1627', {
      ACCEPTANCE_PR_REF: 'subtask/MOTIR-100-unrelated',
      ACCEPTANCE_FALLBACK_STORY_KEY: 'MOTIR-1627',
    });
    expect(r).toEqual({ storyKey: 'MOTIR-1627', source: 'recording' });
  });

  it('3. no self-declared story → the PR ref MOTIR-<id> (subtask → parent server-side)', () => {
    const r = resolveStoryKey(null, {
      ACCEPTANCE_PR_REF: 'subtask/MOTIR-816-importer',
      ACCEPTANCE_FALLBACK_STORY_KEY: 'MOTIR-1627',
    });
    expect(r).toEqual({ storyKey: 'MOTIR-816', source: 'pr' });
  });

  it('3b. PR title is parsed when the ref carries no key', () => {
    const r = resolveStoryKey(null, {
      ACCEPTANCE_PR_REF: 'main',
      ACCEPTANCE_PR_TITLE: 'feat: importer (MOTIR-816)',
      ACCEPTANCE_FALLBACK_STORY_KEY: 'MOTIR-1627',
    });
    expect(r).toEqual({ storyKey: 'MOTIR-816', source: 'pr' });
  });

  it('4. nothing declared and no PR id (push-to-main) → the dogfood fallback', () => {
    const r = resolveStoryKey(null, {
      ACCEPTANCE_PR_REF: '',
      ACCEPTANCE_PR_TITLE: '',
      ACCEPTANCE_FALLBACK_STORY_KEY: 'MOTIR-1627',
    });
    expect(r).toEqual({ storyKey: 'MOTIR-1627', source: 'fallback' });
  });

  it('nothing resolves → null (a misconfiguration the caller errors on)', () => {
    expect(resolveStoryKey(null, {})).toEqual({ storyKey: null, source: 'none' });
  });
});

// MOTIR-1911 — the artifact-size boundary. Measured on run 30579274284: the
// cadence recording's trace.zip was 118,924,401 B against a 104,857,600 B cap
// while its video.webm was 6,340,169 B, so MOTIR-813 lost its receipt to an
// artifact that is a debugging aid rather than the receipt.
describe('assessArtifactSizes (MOTIR-1911)', () => {
  /** Write a file of exactly `bytes` bytes. */
  function sized(dir: string, name: string, bytes: number): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.alloc(bytes));
    return file;
  }

  it('passes both artifacts when they are under the cap', () => {
    const dir = tmpDir();
    const result = assessArtifactSizes({
      video: sized(dir, 'v.webm', 10),
      trace: sized(dir, 't.zip', 20),
      maxBytes: 100,
    });
    expect(result).toMatchObject({
      videoBytes: 10,
      traceBytes: 20,
      publishable: true,
      reason: null,
      dropTrace: false,
      dropReason: null,
    });
  });

  it('DROPS an over-cap trace but keeps the recording publishable — the receipt is the video', () => {
    const dir = tmpDir();
    const result = assessArtifactSizes({
      video: sized(dir, 'v.webm', 10),
      trace: sized(dir, 't.zip', 300),
      maxBytes: 100,
    });
    expect(result.publishable).toBe(true);
    expect(result.dropTrace).toBe(true);
    expect(result.dropReason).toContain('the trace is');
  });

  it('REJECTS an over-cap video — the receipt itself cannot be dropped', () => {
    const dir = tmpDir();
    const result = assessArtifactSizes({
      video: sized(dir, 'v.webm', 300),
      trace: sized(dir, 't.zip', 10),
      maxBytes: 100,
    });
    expect(result.publishable).toBe(false);
    expect(result.reason).toContain('the video is');
    expect(result.dropTrace).toBe(false);
  });

  it('a recording with no trace measures the video alone', () => {
    const dir = tmpDir();
    const result = assessArtifactSizes({
      video: sized(dir, 'v.webm', 10),
      trace: null,
      maxBytes: 100,
    });
    expect(result).toMatchObject({ traceBytes: null, dropTrace: false, publishable: true });
  });

  it('an artifact exactly AT the cap is fine — the limit is inclusive, as Blob’s is', () => {
    const dir = tmpDir();
    const result = assessArtifactSizes({
      video: sized(dir, 'v.webm', 100),
      trace: sized(dir, 't.zip', 100),
      maxBytes: 100,
    });
    expect(result).toMatchObject({ publishable: true, dropTrace: false });
  });

  it('abstains on an unreadable file rather than guessing a size', () => {
    const result = assessArtifactSizes({
      video: path.join(os.tmpdir(), 'no-such-video-xyz.webm'),
      trace: null,
      maxBytes: 1,
    });
    expect(result).toMatchObject({ videoBytes: null, publishable: true });
  });
});

describe('resolveMaxArtifactBytes (MOTIR-1911)', () => {
  it('defaults to the cloud `scaled` tier per-file cap', () => {
    expect(resolveMaxArtifactBytes({})).toBe(DEFAULT_MAX_ARTIFACT_BYTES);
    expect(DEFAULT_MAX_ARTIFACT_BYTES).toBe(104857600);
  });

  it('honours an explicit override — a deployment on the 10 MB baseline sets it', () => {
    expect(resolveMaxArtifactBytes({ ACCEPTANCE_MAX_ARTIFACT_BYTES: '10485760' })).toBe(10485760);
  });

  it('IGNORES a junk / non-positive override rather than disabling the gate', () => {
    for (const raw of ['', '   ', 'lots', '0', '-5', 'NaN']) {
      expect(resolveMaxArtifactBytes({ ACCEPTANCE_MAX_ARTIFACT_BYTES: raw })).toBe(
        DEFAULT_MAX_ARTIFACT_BYTES,
      );
    }
  });
});

describe('uploadAcceptanceVideo', () => {
  interface FetchInit {
    method?: string;
    headers: Record<string, string>;
    body: string;
  }

  /** A fetch mock that answers the mint-token call, the presigned PUT(s), then
   *  the register call. */
  function stubPublishFetch(evidenceId = 'ev1', tokens?: unknown) {
    const fetchMock = vi.fn(async (url: string, init: FetchInit) => {
      if (url.endsWith('/upload-token')) {
        return {
          ok: true,
          json: async () =>
            tokens ?? {
              video: {
                pathname: 'acceptance/w/s/uuid-acceptance.webm',
                token: signedPutUrl('acceptance/w/s/uuid-acceptance.webm'),
                contentType: 'video/webm',
              },
              trace: null,
            },
        };
      }
      if (init?.method === 'PUT') return { ok: true, status: 200, text: async () => '' };
      return { ok: true, json: async () => ({ evidence: { id: evidenceId } }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('mints a token, PUTs the video direct to Blob, then registers the pathname as JSON', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'v.webm');
    fs.writeFileSync(video, 'bytes');
    const fetchMock = stubPublishFetch('ev1');

    const result = await uploadAcceptanceVideo({
      baseUrl: 'https://app.motir.co/',
      token: 'motir_pat_abc',
      storyKey: 'MOTIR-1627',
      artifacts: { video, trace: null, chapters: null },
      provenance: { commitSha: 'abc', ciRunUrl: null, producedByKey: 'MOTIR-1638' },
    });

    expect(result).toEqual({ evidence: { id: 'ev1' } });

    // 1. Mint-token call.
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe(
      'https://app.motir.co/api/work-items/MOTIR-1627/acceptance-evidence/upload-token',
    );
    expect(tokenInit.headers.authorization).toBe('Bearer motir_pat_abc');
    expect(JSON.parse(tokenInit.body)).toEqual({ hasTrace: false });

    // 2. Direct PUT to the presigned URL — NOT through the API. The
    //    `content-type` header is REQUIRED and must equal the type the server
    //    bound at signing time: it is inside X-Amz-SignedHeaders, so a missing
    //    or mismatched one is a signature failure (MOTIR-2389).
    const puts = putCalls(fetchMock);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe(signedPutUrl('acceptance/w/s/uuid-acceptance.webm'));
    expect(puts[0]!.contentType).toBe('video/webm');

    // 3. Register call — JSON pathnames, never the bytes.
    const [registerUrl, registerInit] = fetchMock.mock.calls[2]!;
    expect(registerUrl).toBe('https://app.motir.co/api/work-items/MOTIR-1627/acceptance-evidence');
    expect(registerInit.headers['content-type']).toBe('application/json');
    expect(JSON.parse(registerInit.body)).toMatchObject({
      videoPathname: 'acceptance/w/s/uuid-acceptance.webm',
      tracePathname: null,
      commitSha: 'abc',
      producedByKey: 'MOTIR-1638',
    });
  });

  it('uses keyless OIDC headers (marker + OIDC bearer) on both calls', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'v.webm');
    fs.writeFileSync(video, 'bytes');
    const fetchMock = stubPublishFetch('ev2');

    await uploadAcceptanceVideo({
      baseUrl: 'https://app.motir.co',
      oidcToken: 'oidc.jwt.token',
      storyKey: 'MOTIR-1627',
      artifacts: { video, trace: null, chapters: null },
    });

    // The two API calls carry the auth headers. The presigned PUT deliberately
    // does NOT — its authorization IS the signature, and sending a bearer to the
    // object store would leak the credential to a third party.
    const apiCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/'));
    expect(apiCalls).toHaveLength(2);
    for (const [, init] of apiCalls) {
      expect(init.headers.authorization).toBe('Bearer oidc.jwt.token');
      expect(init.headers['x-motir-auth']).toBe('github-oidc');
    }
    expect(putCalls(fetchMock)[0]!.contentType).toBe('video/webm');
  });

  it('uploads the trace too and registers both pathnames when a trace is present', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'v.webm');
    const trace = path.join(dir, 't.zip');
    fs.writeFileSync(video, 'bytes');
    fs.writeFileSync(trace, 'trace-bytes');
    const fetchMock = stubPublishFetch('ev3', {
      video: {
        pathname: 'acceptance/w/s/uuid-acceptance.webm',
        token: signedPutUrl('acceptance/w/s/uuid-acceptance.webm'),
        contentType: 'video/webm',
      },
      trace: {
        pathname: 'acceptance/w/s/uuid-trace.zip',
        token: signedPutUrl('acceptance/w/s/uuid-trace.zip'),
        contentType: 'application/zip',
      },
    });

    await uploadAcceptanceVideo({
      baseUrl: 'https://app.motir.co',
      token: 't',
      storyKey: 'MOTIR-1627',
      artifacts: { video, trace, chapters: null },
    });

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ hasTrace: true });
    // Each artifact PUTs with ITS OWN bound content type — the trace must not
    // inherit the video's, or it lands as the wrong thing (the bound-at-signing
    // hazard this seam exists to make impossible).
    expect(putCalls(fetchMock).map((c) => c.contentType)).toEqual([
      'video/webm',
      'application/zip',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[3]![1].body)).toMatchObject({
      videoPathname: 'acceptance/w/s/uuid-acceptance.webm',
      tracePathname: 'acceptance/w/s/uuid-trace.zip',
    });
  });

  it('throws when the register call returns a non-2xx response', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'v.webm');
    fs.writeFileSync(video, 'bytes');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (url.endsWith('/upload-token')) {
          return {
            ok: true,
            json: async () => ({
              video: {
                pathname: 'acceptance/w/s/v.webm',
                token: signedPutUrl('acceptance/w/s/v.webm'),
                contentType: 'video/webm',
              },
              trace: null,
            }),
          };
        }
        if (init?.method === 'PUT') return { ok: true, status: 200, text: async () => '' };
        return { ok: false, status: 400, text: async () => 'ACCEPTANCE_EVIDENCE_BLOB_MISSING' };
      }),
    );
    await expect(
      uploadAcceptanceVideo({
        baseUrl: 'https://app.motir.co',
        token: 't',
        storyKey: 'MOTIR-1627',
        artifacts: { video, trace: null, chapters: null },
      }),
    ).rejects.toThrow(/400/);
  });

  // MOTIR-1911 — the mint reports the cap it bound into the grant, so an over-cap
  // artifact fails by NAME here. Since MOTIR-2389 the presigned PUT has no size
  // ceiling of its own, so this up-front check is what stops a doomed upload from
  // being sent in full only to be refused by the register step.
  it('refuses an artifact over the MINTED cap, by name, before it is uploaded', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'v.webm');
    fs.writeFileSync(video, Buffer.alloc(50));
    const fetchMock = stubPublishFetch('ev-cap', {
      video: {
        pathname: 'acceptance/v.webm',
        token: signedPutUrl('acceptance/v.webm'),
        contentType: 'video/webm',
        maxBytes: 10,
      },
      trace: null,
    });

    await expect(
      uploadAcceptanceVideo({
        baseUrl: 'https://app.motir.co',
        token: 'motir_pat_abc',
        storyKey: 'MOTIR-813',
        artifacts: { video, trace: null, chapters: null },
      }),
    ).rejects.toThrow(/the video is .* over the publish target's .* per-file limit/);
    expect(putCalls(fetchMock)).toHaveLength(0);
  });

  it('abstains when the mint reports no cap (an older server) — the flow is unchanged', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'v.webm');
    fs.writeFileSync(video, Buffer.alloc(50));
    const fetchMock = stubPublishFetch('ev-nocap'); // the default stub carries no `maxBytes`

    await expect(
      uploadAcceptanceVideo({
        baseUrl: 'https://app.motir.co',
        token: 'motir_pat_abc',
        storyKey: 'MOTIR-813',
        artifacts: { video, trace: null, chapters: null },
      }),
    ).resolves.toEqual({ evidence: { id: 'ev-nocap' } });
    expect(putCalls(fetchMock)).toHaveLength(1);
  });

  it('throws when the token mint returns a non-2xx response (before any upload)', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'v.webm');
    fs.writeFileSync(video, 'bytes');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 402, text: async () => 'no_plan' }),
    );
    await expect(
      uploadAcceptanceVideo({
        baseUrl: 'https://app.motir.co',
        token: 't',
        storyKey: 'MOTIR-1627',
        artifacts: { video, trace: null, chapters: null },
      }),
    ).rejects.toThrow(/402/);
  });
});

// The ORCHESTRATION — the layer the MOTIR-1734 bug actually lived in. Both its
// parts were covered and correct; the loop between them published one story and
// dropped the rest, so nothing failed. These drive `main()` end to end over a
// fixture output dir, with the network + Blob mocked.
describe('main — one publish per recording (MOTIR-1734)', () => {
  const ENV_KEYS = [
    'ACCEPTANCE_OUTPUT_DIR',
    'MOTIR_UPLOAD_TOKEN',
    'MOTIR_BASE_URL',
    'ACCEPTANCE_STORY_KEY',
    'ACCEPTANCE_PR_REF',
    'ACCEPTANCE_PR_TITLE',
    'ACCEPTANCE_FALLBACK_STORY_KEY',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    // MOTIR-1905 — the two CI reporting channels. Cleared per test so the
    // annotation assertion is explicit about turning them ON, and so a real
    // `GITHUB_STEP_SUMMARY` (this suite DOES run under Actions) is never
    // appended to by the tests.
    'GITHUB_ACTIONS',
    'GITHUB_STEP_SUMMARY',
    // MOTIR-1937 — the spec-ownership gate. In ENV_KEYS so each test starts from
    // a known owned-set rather than inheriting the ambient one.
    'ACCEPTANCE_CHANGED_SPECS',
    // MOTIR-1911 — the per-file cap. The size cases set a tiny one so a fixture
    // is "over the limit" at a handful of bytes rather than 100 MB on disk.
    'ACCEPTANCE_MAX_ARTIFACT_BYTES',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // PAT auth (no OIDC vars → keyless path is skipped).
    process.env['MOTIR_UPLOAD_TOKEN'] = 'motir_pat_test';
    process.env['MOTIR_BASE_URL'] = 'https://app.motir.co';
    // Start owning NOTHING; `writeRecording` adds each fixture's spec as it is
    // created (MOTIR-1937), so a publish case owns exactly what it recorded and
    // an ownership case opts out per recording with `owned: false`.
    process.env['ACCEPTANCE_CHANGED_SPECS'] = '';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** The story key each register call targeted, in call order. */
  function publishedStories(fetchMock: { mock: { calls: unknown[][] } }): string[] {
    return (
      fetchMock.mock.calls
        .map(([url]) => String(url))
        // The presigned PUTs go to the object store, not the API — only the
        // register calls (the API URL, without the mint suffix) count.
        .filter((url) => url.includes('/acceptance-evidence') && !url.endsWith('/upload-token'))
        .map((url) => /work-items\/([^/]+)\/acceptance-evidence/.exec(url)?.[1] ?? '')
    );
  }

  /** The JSON body of the FIRST register call (the mint calls carry a different
   *  shape) — how a test inspects what was actually registered. */
  function registeredBody(fetchMock: {
    mock: { calls: Array<[string, { body?: string }?]> };
  }): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(
      ([url]) => url.includes('/acceptance-evidence') && !url.endsWith('/upload-token'),
    );
    return JSON.parse(call?.[1]?.body ?? '{}') as Record<string, unknown>;
  }

  function stubFetch(onRegister?: (storyKey: string) => { ok: boolean; status?: number }) {
    const fetchMock = vi.fn(async (url: string, init?: { body?: string; method?: string }) => {
      if (init?.method === 'PUT') return { ok: true, status: 200, text: async () => '' };
      if (url.endsWith('/upload-token')) {
        return {
          ok: true,
          json: async () => ({
            video: {
              pathname: 'acceptance/v.webm',
              token: signedPutUrl('acceptance/v.webm'),
              contentType: 'video/webm',
            },
            trace: {
              pathname: 'acceptance/t.zip',
              token: signedPutUrl('acceptance/t.zip'),
              contentType: 'application/zip',
            },
          }),
        };
      }
      const storyKey = /work-items\/([^/]+)\//.exec(url)?.[1] ?? '';
      const verdict = onRegister?.(storyKey) ?? { ok: true };
      if (!verdict.ok) {
        return { ok: false, status: verdict.status ?? 500, text: async () => 'boom' };
      }
      return { ok: true, json: async () => ({ evidence: { id: `ev-${storyKey}` } }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('REFUSES to publish an unwatchable recording — nothing uploads, the step fails', async () => {
    // The MOTIR-1772 gate end to end: the guard must bite in `main`, BEFORE any
    // auth or upload, so a raced recording can never land as a story's receipt.
    const dir = tmpDir();
    writeRecording(dir, 'acceptance-raced-chromium', {
      storyKey: 'MOTIR-813',
      chapters: JSON.stringify([
        { label: 'one', tSeconds: 1.7 },
        { label: 'two', tSeconds: 2.5 },
        { label: 'three', tSeconds: 3.1 },
      ]),
      totalSeconds: 5,
    });
    process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
    const fetchMock = stubFetch();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await expect(main()).rejects.toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
    // NOTHING was published — not even a token mint.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // MOTIR-1905 — the blast radius of ONE unwatchable clip.
  //
  // The gate used to `process.exit(1)` before publishing anything, so a single
  // unpaced spec suppressed EVERY story's receipt in the lane. That is exactly
  // what shipped: `acceptance-augment-replan` recorded ~9.5s and, from the day
  // the floor landed, no story got a video on `main` or on any PR — while the
  // step read green behind `continue-on-error`.
  it('an UNWATCHABLE recording costs only its OWN story — the others still publish (MOTIR-1905)', async () => {
    const dir = tmpDir();
    writeRecording(dir, 'acceptance-good-a-chromium', { storyKey: 'MOTIR-1863' });
    writeRecording(dir, 'acceptance-raced-chromium', {
      storyKey: 'MOTIR-811',
      chapters: JSON.stringify([
        { label: 'one', tSeconds: 0.5 },
        { label: 'two', tSeconds: 3.0 },
      ]),
      totalSeconds: 9.5, // the real regression's duration
    });
    writeRecording(dir, 'acceptance-good-b-chromium', { storyKey: 'MOTIR-1627' });
    process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const fetchMock = stubFetch();

    await main();

    // The two watchable recordings published; the raced one did NOT.
    expect(publishedStories(fetchMock)).toEqual(['MOTIR-1863', 'MOTIR-1627']);
    expect(publishedStories(fetchMock)).not.toContain('MOTIR-811');
    // …and the step still fails, so a partial publish is never silently green.
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('MOTIR-811'));
  });

  it('emits a CI annotation for an unwatchable clip, so continue-on-error cannot hide it (MOTIR-1905)', async () => {
    const dir = tmpDir();
    writeRecording(dir, 'acceptance-good-chromium', { storyKey: 'MOTIR-1863' });
    writeRecording(dir, 'acceptance-raced-chromium', {
      storyKey: 'MOTIR-811',
      chapters: JSON.stringify([{ label: 'one', tSeconds: 0.5 }]),
      totalSeconds: 9.5,
    });
    process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
    process.env['GITHUB_ACTIONS'] = 'true';
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // Re-spy and hold the reference, rather than asserting on `console.log`
    // directly — naming it is what trips the no-console lint rule.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stubFetch();

    await main();

    // The `::error::` workflow command is the channel `continue-on-error` does
    // NOT rewrite — the step's own conclusion is reported as `success`.
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^::error::.*MOTIR-811/));
  });

  // ── The artifact-size gate, end to end (MOTIR-1911) ────────────────────────
  //
  // The reproduction: MOTIR-813's recording carried a 113 MB trace beside a 6 MB
  // video, and the whole publish died inside `put` — so the story with a
  // perfectly good clip was the one story of eight with no receipt.

  it('DROPS an over-limit trace and still publishes the video — MOTIR-813’s case', async () => {
    const dir = tmpDir();
    const recording = writeRecording(dir, 'acceptance-cadence-chromium', {
      storyKey: 'MOTIR-813',
      totalSeconds: 96,
    });
    // A trace over the cap; the video (5 bytes of 'clip') stays well under it.
    fs.writeFileSync(path.join(recording, 'trace.zip'), Buffer.alloc(40));
    process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
    process.env['ACCEPTANCE_MAX_ARTIFACT_BYTES'] = '20';
    process.env['GITHUB_ACTIONS'] = 'true';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const fetchMock = stubFetch();

    await main();

    // The receipt published, and the register call carries NO trace pathname.
    expect(publishedStories(fetchMock)).toEqual(['MOTIR-813']);
    expect(registeredBody(fetchMock).tracePathname).toBeNull();
    // Only the VIDEO reached the object store — the trace was never uploaded.
    expect(putCalls(fetchMock)).toHaveLength(1);
    // Reported as a WARNING, not a failure: the receipt is there, so the run is
    // not broken.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DROPPED'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^::warning::.*MOTIR-813/));
    expect(exit).not.toHaveBeenCalled();
  });

  it('the trace is NOT dropped when the mint reports no cap and the file fits', async () => {
    const dir = tmpDir();
    writeRecording(dir, 'acceptance-cadence-chromium', { storyKey: 'MOTIR-813' });
    process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
    const fetchMock = stubFetch();

    await main();

    expect(putCalls(fetchMock)).toHaveLength(2); // video + trace
    expect(registeredBody(fetchMock).tracePathname).toBe('acceptance/t.zip');
  });

  it('REFUSES an over-limit VIDEO up front — annotated, never uploaded, siblings unaffected', async () => {
    const dir = tmpDir();
    const fat = writeRecording(dir, 'acceptance-fat-chromium', { storyKey: 'MOTIR-811' });
    fs.writeFileSync(path.join(fat, 'video.webm'), Buffer.alloc(40));
    writeRecording(dir, 'acceptance-good-chromium', { storyKey: 'MOTIR-1627' });
    process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
    process.env['ACCEPTANCE_MAX_ARTIFACT_BYTES'] = '20';
    process.env['GITHUB_ACTIONS'] = 'true';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const fetchMock = stubFetch();

    await main();

    // The over-limit recording never reached a token mint; its sibling published.
    expect(publishedStories(fetchMock)).toEqual(['MOTIR-1627']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^::error::.*MOTIR-811/));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('TOO LARGE'));
    // Same shape as the watchability verdict: reported, and the step fails.
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still publishes a legacy recording with no meta sidecar (the guard abstains)', async () => {
    const dir = tmpDir();
    writeRecording(dir, 'acceptance-legacy-chromium', { storyKey: 'MOTIR-1627' });
    process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
    const fetchMock = stubFetch();

    await main();

    expect(publishedStories(fetchMock)).toEqual(['MOTIR-1627']);
  });

  it('publishes ALL THREE chaptered recordings, each to its own declared story', async () => {
    const dir = tmpDir();
    writeRecording(dir, 'acceptance-augment-replan-chromium', { storyKey: 'MOTIR-811' });
    writeRecording(dir, 'acceptance-plan-change-chromium', { storyKey: 'MOTIR-1726' });
    writeRecording(dir, 'acceptance-video-dogfood-chromium', { storyKey: 'MOTIR-1627' });
    process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
    // A PR ref that would resolve a DIFFERENT story — each recording's own
    // sidecar must win, exactly as it does for a single publish.
    process.env['ACCEPTANCE_PR_REF'] = 'subtask/MOTIR-1733-acceptance-e2e';
    const fetchMock = stubFetch();

    await main();

    expect(publishedStories(fetchMock)).toEqual(['MOTIR-811', 'MOTIR-1726', 'MOTIR-1627']);
    // Video + trace per recording — the exact bug's blast radius was that only
    // one clip ever reached the object store.
    expect(putCalls(fetchMock)).toHaveLength(6);
  });

  it('a failing publish does not cost the other recordings theirs — and the run exits non-zero', async () => {
    const dir = tmpDir();
    writeRecording(dir, 'aaa-chromium', { storyKey: 'MOTIR-811' });
    writeRecording(dir, 'bbb-chromium', { storyKey: 'MOTIR-1726' });
    writeRecording(dir, 'ccc-chromium', { storyKey: 'MOTIR-1627' });
    process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const fetchMock = stubFetch((storyKey) =>
      storyKey === 'MOTIR-1726' ? { ok: false, status: 500 } : { ok: true },
    );

    await main();

    // All three were ATTEMPTED; the middle one failed.
    expect(publishedStories(fetchMock)).toEqual(['MOTIR-811', 'MOTIR-1726', 'MOTIR-1627']);
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('MOTIR-1726'));
  });

  it('publishes nothing when the run recorded no video (a red run)', async () => {
    process.env['ACCEPTANCE_OUTPUT_DIR'] = tmpDir();
    const fetchMock = stubFetch();
    await main();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an un-chaptered suite still publishes one recording, via the PR-derived story', async () => {
    const dir = tmpDir();
    writeRecording(dir, 'plain-test-chromium', { chapters: null });
    process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
    process.env['ACCEPTANCE_PR_REF'] = 'subtask/MOTIR-816-importer';
    const fetchMock = stubFetch();

    await main();

    expect(publishedStories(fetchMock)).toEqual(['MOTIR-816']);
  });

  it('is a no-op (not a failure) with neither OIDC nor a PAT — BYOK is opt-in', async () => {
    const dir = tmpDir();
    writeRecording(dir, 'acceptance-chromium', { storyKey: 'MOTIR-1726' });
    process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
    delete process.env['MOTIR_UPLOAD_TOKEN'];
    const fetchMock = stubFetch();

    await main();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── A run publishes only the specs it OWNS (MOTIR-1937) ──────────────────
  //
  // The bug: publishing supersedes, and each recording targets its OWN declared
  // story, so any code PR replaced the receipts of every story with a chaptered
  // spec. The gate is OWNERSHIP, not the branch — the acceptance panel's approve
  // edge is `in_review → done` and `in_review` is the PR-OPEN state, so a story's
  // receipt has to be published FROM its own PR or the reviewer can never
  // watch-then-approve.

  describe('the ownership gate', () => {
    it('publishes NOTHING for a PR that changed no acceptance spec — the seven-story case', async () => {
      const dir = tmpDir();
      // Exactly the MOTIR-1781 shape: a backend PR whose lane still recorded
      // three specs, none of which it touched.
      writeRecording(dir, 'acceptance-augment-replan-chromium', {
        storyKey: 'MOTIR-811',
        owned: false,
      });
      writeRecording(dir, 'acceptance-plan-change-chromium', {
        storyKey: 'MOTIR-1726',
        owned: false,
      });
      writeRecording(dir, 'acceptance-video-dogfood-chromium', {
        storyKey: 'MOTIR-1627',
        owned: false,
      });
      process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
      process.env['ACCEPTANCE_PR_REF'] = 'subtask/MOTIR-1781-repo-creation-primitive';
      const fetchMock = stubFetch();

      await main();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('publishes ONLY the story whose spec this PR changed, not its siblings', async () => {
      // The story acceptance-E2E PR: it owns one spec, and the other two
      // recordings in the lane must be left exactly as they are.
      const dir = tmpDir();
      writeRecording(dir, 'acceptance-cadence-chromium', { storyKey: 'MOTIR-813' });
      writeRecording(dir, 'acceptance-plan-change-chromium', {
        storyKey: 'MOTIR-1726',
        owned: false,
      });
      writeRecording(dir, 'acceptance-video-dogfood-chromium', {
        storyKey: 'MOTIR-1627',
        owned: false,
      });
      process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
      const fetchMock = stubFetch();

      await main();

      expect(publishedStories(fetchMock)).toEqual(['MOTIR-813']);
    });

    it('FAILS CLOSED — an unset owned-set publishes nothing', async () => {
      const dir = tmpDir();
      writeRecording(dir, 'acceptance-chromium', { storyKey: 'MOTIR-1627', owned: false });
      process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
      delete process.env['ACCEPTANCE_CHANGED_SPECS'];
      const fetchMock = stubFetch();

      await main();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does NOT own a recording whose sidecar predates the specFile field', async () => {
      const dir = tmpDir();
      writeRecording(dir, 'acceptance-legacy-chromium', {
        storyKey: 'MOTIR-1627',
        specFile: null,
      });
      process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
      process.env['ACCEPTANCE_CHANGED_SPECS'] = 'tests/e2e/acceptance-legacy-chromium.spec.ts';
      const fetchMock = stubFetch();

      await main();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still RESOLVES and REPORTS an un-owned recording — the checks a PR pays for', async () => {
      const dir = tmpDir();
      writeRecording(dir, 'acceptance-a-chromium', { storyKey: 'MOTIR-811', owned: false });
      process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      stubFetch();

      await main();

      const logged = logSpy.mock.calls.flat().join('\n');
      expect(logged).toContain('MOTIR-811');
      expect(logged).toContain('rehearsed');
    });

    it('still FAILS on an unwatchable clip it does not own — the floor is a PR-time check', async () => {
      // Why the gate is applied AFTER the watchability assessment: pacing is a
      // defect whoever is looking at this run can fix, and deferring the check to
      // the owning run is the MOTIR-1905 blind spot.
      const dir = tmpDir();
      writeRecording(dir, 'acceptance-raced-chromium', {
        storyKey: 'MOTIR-811',
        owned: false,
        chapters: JSON.stringify([
          { label: 'one', tSeconds: 0.5 },
          { label: 'two', tSeconds: 3.0 },
        ]),
        totalSeconds: 9.5,
      });
      process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
      process.env['GITHUB_ACTIONS'] = 'true';
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const fetchMock = stubFetch();

      await main();

      expect(exit).toHaveBeenCalledWith(1);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('::error::Unwatchable acceptance video for MOTIR-811'),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('needs no credential when it owns nothing', async () => {
      const dir = tmpDir();
      writeRecording(dir, 'acceptance-chromium', { storyKey: 'MOTIR-1627', owned: false });
      process.env['ACCEPTANCE_OUTPUT_DIR'] = dir;
      delete process.env['MOTIR_UPLOAD_TOKEN'];
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

      await main();

      expect(exit).not.toHaveBeenCalled();
    });
  });
});

// ── The spec-OWNERSHIP gate (MOTIR-1937) ────────────────────────────────────

describe('resolveOwnedSpecs', () => {
  it('parses the `git diff --name-only` output shape verbatim', () => {
    expect(
      resolveOwnedSpecs({
        ACCEPTANCE_CHANGED_SPECS:
          'tests/e2e/acceptance-a.spec.ts\ntests/e2e/acceptance-b.spec.ts\n',
      }),
    ).toEqual(new Set(['tests/e2e/acceptance-a.spec.ts', 'tests/e2e/acceptance-b.spec.ts']));
  });

  it('accepts space- and comma-separated lists, and strips a leading ./', () => {
    expect(
      resolveOwnedSpecs({ ACCEPTANCE_CHANGED_SPECS: './a.spec.ts, b.spec.ts  c.spec.ts' }),
    ).toEqual(new Set(['a.spec.ts', 'b.spec.ts', 'c.spec.ts']));
  });

  it.each([
    ['unset', {}],
    ['empty', { ACCEPTANCE_CHANGED_SPECS: '' }],
    ['whitespace only', { ACCEPTANCE_CHANGED_SPECS: '  \n ' }],
  ])('owns NOTHING for %s — the gate fails closed', (_label, env) => {
    expect(resolveOwnedSpecs(env)).toEqual(new Set());
  });
});

describe('isOwnedRecording', () => {
  const owned = new Set(['tests/e2e/acceptance-cadence.spec.ts']);

  it('owns a recording whose spec this run changed', () => {
    expect(isOwnedRecording({ specFile: 'tests/e2e/acceptance-cadence.spec.ts' }, owned)).toBe(
      true,
    );
  });

  it('normalises a leading ./ on the recording side too', () => {
    expect(isOwnedRecording({ specFile: './tests/e2e/acceptance-cadence.spec.ts' }, owned)).toBe(
      true,
    );
  });

  it('does NOT own a sibling spec the run did not touch', () => {
    expect(isOwnedRecording({ specFile: 'tests/e2e/acceptance-cli-connect.spec.ts' }, owned)).toBe(
      false,
    );
  });

  it.each([
    ['a legacy sidecar with no specFile', {}],
    ['a null specFile', { specFile: null }],
    ['an empty specFile', { specFile: '' }],
    ['no meta at all', null],
  ])('does NOT own %s — an unidentifiable recording is never published', (_label, meta) => {
    expect(isOwnedRecording(meta as { specFile?: string | null }, owned)).toBe(false);
  });
});

// ── The watchability guard (MOTIR-1772) ──────────────────────────────────────

/** Chapter markers `n` seconds apart, the shape `chapter()` writes. */
function chaptersEvery(gapSeconds: number, count: number, start = 1) {
  return Array.from({ length: count }, (_, i) => ({
    label: `phase ${i + 1}`,
    tSeconds: start + i * gapSeconds,
  }));
}

describe('assessWatchability (MOTIR-1772)', () => {
  it('passes a paced recording — the MOTIR-921 clip AFTER it was paced', () => {
    const verdict = assessWatchability({
      chapters: [
        { label: 'Turn on auto-planning', tSeconds: 1.8 },
        { label: 'Approve the proposed sprints', tSeconds: 30.6 },
        { label: 'Cadence fires on its own', tSeconds: 51.3 },
        { label: 'Auto-plan pauses for review', tSeconds: 59.7 },
        { label: 'Decide, and cadence resumes', tSeconds: 64.1 },
      ],
      meta: { totalSeconds: 78 },
    });
    expect(verdict.watchable).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('FAILS the exact MOTIR-921 regression — five chapters inside four seconds', () => {
    const verdict = assessWatchability({
      chapters: [
        { label: 'Turn on auto-planning', tSeconds: 1.78 },
        { label: 'Approve the proposed sprints', tSeconds: 2.53 },
        { label: 'Cadence fires on its own', tSeconds: 3.07 },
        { label: 'Auto-plan pauses for review', tSeconds: 3.4 },
        { label: 'Decide, and cadence resumes', tSeconds: 3.73 },
      ],
      meta: { totalSeconds: 5 },
    });
    expect(verdict.watchable).toBe(false);
    // The clip is short AND bunched; the floor is the first thing it trips.
    expect(verdict.reason).toContain('watchable floor');
  });

  it('FAILS a long-enough clip whose chapters are BUNCHED (a paced tail cannot rescue a raced opening)', () => {
    const verdict = assessWatchability({
      chapters: chaptersEvery(0.5, 6),
      meta: { totalSeconds: 40 },
    });
    expect(verdict.watchable).toBe(false);
    expect(verdict.reason).toContain('bunched');
  });

  it('ABSTAINS when there is no recording-meta sidecar (legacy / non-chaptered run)', () => {
    // Absence of evidence is not evidence of a bad clip — this guard must not
    // red-light runs it was never meant to police.
    expect(assessWatchability({ chapters: [], meta: null }).watchable).toBe(true);
    expect(assessWatchability({}).watchable).toBe(true);
  });

  it('passes a single-chapter recording that is simply long — no gaps to judge', () => {
    const verdict = assessWatchability({
      chapters: [{ label: 'only phase', tSeconds: 1 }],
      meta: { totalSeconds: 45 },
    });
    expect(verdict.watchable).toBe(true);
    expect(verdict.medianGapSeconds).toBeNull();
  });

  it('applies a FLOOR and never a ceiling — the ADR withdrew the duration cap', () => {
    const verdict = assessWatchability({
      chapters: chaptersEvery(30, 8),
      meta: { totalSeconds: 600 },
    });
    expect(verdict.watchable).toBe(true);
  });
});
