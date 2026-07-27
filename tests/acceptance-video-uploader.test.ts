import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The client-direct blob upload (MOTIR-1681) is mocked so the uploader never
// hits the network — the test asserts the mint → put → register orchestration.
vi.mock('@vercel/blob/client', () => ({
  put: vi.fn(async (pathname: string) => ({ pathname })),
}));

// The BYOK uploader (Subtask MOTIR-1632; direct-to-Blob MOTIR-1681) — pure
// logic, no DB. Tests the no-op (red-run) path + the mint/upload/register flow.
import {
  findRecordings,
  main,
  parseWorkItemKey,
  resolveStoryKey,
  uploadAcceptanceVideo,
} from '../scripts/upload-acceptance-video.mjs';
import { put as putBlobMock } from '@vercel/blob/client';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acc-video-'));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks(); // module-mocked `put` accumulates calls across tests otherwise
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
  return dir;
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

describe('uploadAcceptanceVideo', () => {
  interface FetchInit {
    method?: string;
    headers: Record<string, string>;
    body: string;
  }

  /** A fetch mock that answers the mint-token call then the register call. */
  function stubPublishFetch(evidenceId = 'ev1', tokens?: unknown) {
    const fetchMock = vi.fn(async (url: string, _init: FetchInit) => {
      if (url.endsWith('/upload-token')) {
        return {
          ok: true,
          json: async () =>
            tokens ?? {
              video: {
                pathname: 'acceptance/w/s/uuid-acceptance.webm',
                token: 'client-token-video',
                contentType: 'video/webm',
              },
              trace: null,
            },
        };
      }
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

    // 2. Direct client `put` to Blob with the minted token — NOT through the API.
    expect(putBlobMock).toHaveBeenCalledWith(
      'acceptance/w/s/uuid-acceptance.webm',
      expect.anything(),
      expect.objectContaining({ access: 'private', token: 'client-token-video' }),
    );

    // 3. Register call — JSON pathnames, never the bytes.
    const [registerUrl, registerInit] = fetchMock.mock.calls[1]!;
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

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers.authorization).toBe('Bearer oidc.jwt.token');
      expect(init.headers['x-motir-auth']).toBe('github-oidc');
    }
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
        token: 'ct-v',
        contentType: 'video/webm',
      },
      trace: {
        pathname: 'acceptance/w/s/uuid-trace.zip',
        token: 'ct-t',
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
    expect(putBlobMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({
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
      vi.fn(async (url: string) =>
        url.endsWith('/upload-token')
          ? {
              ok: true,
              json: async () => ({
                video: {
                  pathname: 'acceptance/w/s/v.webm',
                  token: 'ct',
                  contentType: 'video/webm',
                },
                trace: null,
              }),
            }
          : { ok: false, status: 400, text: async () => 'ACCEPTANCE_EVIDENCE_BLOB_MISSING' },
      ),
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
    return fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => !url.endsWith('/upload-token'))
      .map((url) => /work-items\/([^/]+)\/acceptance-evidence/.exec(url)?.[1] ?? '');
  }

  function stubFetch(onRegister?: (storyKey: string) => { ok: boolean; status?: number }) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/upload-token')) {
        return {
          ok: true,
          json: async () => ({
            video: { pathname: 'acceptance/v.webm', token: 'ct', contentType: 'video/webm' },
            trace: { pathname: 'acceptance/t.zip', token: 'ct2', contentType: 'application/zip' },
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
    // one clip ever reached the Blob store.
    expect(putBlobMock).toHaveBeenCalledTimes(6);
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
});
