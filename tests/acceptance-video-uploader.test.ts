import { afterEach, describe, expect, it, vi } from 'vitest';
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
  findArtifacts,
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

describe('findArtifacts', () => {
  it('returns null when the output dir does not exist (nothing ran)', () => {
    expect(findArtifacts(path.join(os.tmpdir(), 'does-not-exist-xyz'))).toBeNull();
  });

  it('returns null when there is no video (a red run recorded none)', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'trace.zip'), 'x');
    expect(findArtifacts(dir)).toBeNull();
  });

  it('pins video + trace to the chapters.json directory even when a sibling recording is walked FIRST (MOTIR-1680)', () => {
    const dir = tmpDir();
    // A multi-test E2E run: the sibling (a non-dogfood test) records a .webm
    // but NO chapters; only the chaptered dogfood writes chapters.json.
    const sibling = path.join(dir, 'aaa-another-test-chromium');
    const dogfood = path.join(dir, 'zzz-dogfood-happy-path-chromium');
    fs.mkdirSync(sibling);
    fs.mkdirSync(dogfood);
    fs.writeFileSync(path.join(sibling, 'video.webm'), 'other-clip');
    fs.writeFileSync(path.join(sibling, 'trace.zip'), 'other-trace');
    fs.writeFileSync(path.join(dogfood, 'video.webm'), 'dogfood-clip');
    fs.writeFileSync(path.join(dogfood, 'trace.zip'), 'dogfood-trace');
    fs.writeFileSync(path.join(dogfood, 'chapters.json'), '[{"label":"Open the story"}]');

    // Force a DETERMINISTIC walk order (name-sorted → the sibling FIRST), so a
    // naive "first .webm across the whole tree" would pick the sibling's clip.
    // The regression this guards against is non-determinism, so the test must
    // not itself depend on the OS's native readdir ordering (restored by the
    // afterEach vi.restoreAllMocks).
    const realReaddir = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((dirPath, options) => {
      const entries = (realReaddir as (p: unknown, o: unknown) => Array<{ name: string }>)(
        dirPath,
        options,
      );
      return [...entries].sort((a, b) => a.name.localeCompare(b.name));
    }) as typeof fs.readdirSync);

    const found = findArtifacts(dir);
    if (!found) throw new Error('expected artifacts to be found');
    // The invariant the fix guarantees, independent of walk order: the
    // published video + trace live in the SAME directory as the chapters
    // sidecar — the dogfood's, never the sibling's.
    expect(path.dirname(found.video)).toBe(dogfood);
    expect(path.dirname(found.trace as string)).toBe(dogfood);
    expect(path.dirname(found.chapters as string)).toBe(dogfood);
    expect(fs.readFileSync(found.video, 'utf8')).toBe('dogfood-clip');
  });

  it('falls back to any .webm when no chapters.json exists (non-chaptered suite)', () => {
    const dir = tmpDir();
    const nested = path.join(dir, 'some-test-chromium');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'video.webm'), 'v');
    fs.writeFileSync(path.join(nested, 'trace.zip'), 't');
    const found = findArtifacts(dir);
    expect(found?.video.endsWith('.webm')).toBe(true);
    expect(found?.chapters).toBeNull();
  });

  it('finds the video + trace + chapters (nested), when present', () => {
    const dir = tmpDir();
    const nested = path.join(dir, 'story-acceptance-flow-chromium');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'video.webm'), 'v');
    fs.writeFileSync(path.join(nested, 'trace.zip'), 't');
    fs.writeFileSync(path.join(nested, 'chapters.json'), '[]');
    const found = findArtifacts(dir);
    expect(found?.video.endsWith('.webm')).toBe(true);
    expect(found?.trace?.endsWith('trace.zip')).toBe(true);
    expect(found?.chapters?.endsWith('chapters.json')).toBe(true);
  });

  it('reads the recording self-declared story from acceptance-story.json (MOTIR-1684)', () => {
    const dir = tmpDir();
    const nested = path.join(dir, 'dogfood-chromium');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'video.webm'), 'v');
    fs.writeFileSync(path.join(nested, 'chapters.json'), '[]');
    fs.writeFileSync(
      path.join(nested, 'acceptance-story.json'),
      JSON.stringify({ storyKey: 'MOTIR-1627' }),
    );
    expect(findArtifacts(dir)?.storyKey).toBe('MOTIR-1627');
  });

  it('storyKey is null when no acceptance-story.json sidecar exists', () => {
    const dir = tmpDir();
    const nested = path.join(dir, 'dogfood-chromium');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'video.webm'), 'v');
    fs.writeFileSync(path.join(nested, 'chapters.json'), '[]');
    expect(findArtifacts(dir)?.storyKey).toBeNull();
  });

  it('pins the story sidecar to the chaptered dogfood dir, not a sibling recording', () => {
    const dir = tmpDir();
    const sibling = path.join(dir, 'aaa-sibling-chromium');
    const dogfood = path.join(dir, 'zzz-dogfood-chromium');
    fs.mkdirSync(sibling);
    fs.mkdirSync(dogfood);
    fs.writeFileSync(path.join(sibling, 'video.webm'), 'other');
    fs.writeFileSync(
      path.join(sibling, 'acceptance-story.json'),
      JSON.stringify({ storyKey: 'MOTIR-9999' }),
    );
    fs.writeFileSync(path.join(dogfood, 'video.webm'), 'dogfood');
    fs.writeFileSync(path.join(dogfood, 'chapters.json'), '[]');
    fs.writeFileSync(
      path.join(dogfood, 'acceptance-story.json'),
      JSON.stringify({ storyKey: 'MOTIR-1627' }),
    );
    expect(findArtifacts(dir)?.storyKey).toBe('MOTIR-1627');
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
