import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  main,
  putSignedArtifact,
  requestGithubOidcToken,
} from '../scripts/upload-acceptance-video.mjs';

// THE BRANCHES THE UNIT SUITE LEFT DARK (Story MOTIR-7250 · Subtask MOTIR-7256).
//
// `tests/acceptance-video-uploader.test.ts` is VENDORED into
// `nextjs-prisma-vercel-starter` byte-for-byte (MOTIR-7255), so it stays a pure
// copy of upstream's suite and the cases the coverage floor asked for live here,
// in a file nobody vendors. Each one is a path a CI run really takes and that the
// restore brought back untested: a token endpoint answering junk, a store whose
// error body cannot be read, the default (real) back-off between retries, and a
// recording no story resolves for.

const SAVED = [
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACCEPTANCE_OUTPUT_DIR',
  'ACCEPTANCE_CHANGED_SPECS',
  'ACCEPTANCE_PR_REF',
  'ACCEPTANCE_PR_TITLE',
  'ACCEPTANCE_STORY_KEY',
  'ACCEPTANCE_FALLBACK_STORY_KEY',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of SAVED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function tmpFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-branches-'));
  const file = path.join(dir, 'video.webm');
  fs.writeFileSync(file, contents);
  return file;
}

describe('requestGithubOidcToken', () => {
  it('answers null — not a throw — when the token endpoint returns a non-JSON body', async () => {
    process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = 'https://oidc.test/token?x=1';
    process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'runtime';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>not json</html>', { status: 200 })),
    );

    // Null is the "no OIDC" answer the caller turns into a named, exit-0 no-op.
    await expect(requestGithubOidcToken()).resolves.toBeNull();
  });
});

describe('putSignedArtifact', () => {
  const target = {
    pathname: 'acceptance/ws/story/v.webm',
    token: 'https://s3.test/bucket/v.webm?X-Amz-Signature=s',
    contentType: 'video/webm',
  };

  it('still names the status when the store’s error body cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        headers: new Headers({ 'x-amz-request-id': 'req-1' }),
        text: () => Promise.reject(new Error('stream torn')),
      })),
    );

    await expect(
      putSignedArtifact('video', tmpFile('clip'), target, { attempts: 1 }),
    ).rejects.toThrow(/Acceptance video upload failed: 403 \[request id req-1\]/);
  });

  it('backs off with the REAL sleep between retries when the caller passes none', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? new Response('slow down', { status: 503, headers: { 'x-amz-request-id': 'r1' } })
          : new Response('', { status: 200, headers: { 'x-amz-request-id': 'r2' } });
      }),
    );

    // `baseDelayMs: 1` keeps the wall-clock negligible; no `sleep` override, so
    // the shipped back-off is the one that runs.
    await putSignedArtifact('video', tmpFile('clip'), target, { attempts: 2, baseDelayMs: 1 });
    expect(calls).toBe(2);
  });
});

describe('main — a recording no story resolves for', () => {
  it('fails the run up front, naming the recording, before any auth or upload', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-branches-out-'));
    const dir = path.join(root, 'acceptance-orphan-chromium');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'video.webm'), 'clip');
    fs.writeFileSync(path.join(dir, 'chapters.json'), '[]');
    fs.writeFileSync(
      path.join(dir, 'recording-meta.json'),
      JSON.stringify({ specFile: 'tests/e2e/acceptance-orphan.spec.ts' }),
    );
    process.env['ACCEPTANCE_OUTPUT_DIR'] = root;
    process.env['ACCEPTANCE_CHANGED_SPECS'] = 'tests/e2e/acceptance-orphan.spec.ts';
    process.env['ACCEPTANCE_PR_REF'] = 'fix-things';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);

    await expect(main()).rejects.toThrow('exit');

    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'No target story resolved for 1 recording(s) (acceptance-orphan-chromium)',
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
