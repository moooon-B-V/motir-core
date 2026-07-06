import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The BYOK uploader (Subtask MOTIR-1632) — pure logic, no DB. Tests the no-op
// (red-run) path + a successful POST via a mocked fetch.
import { findArtifacts, uploadAcceptanceVideo } from '../scripts/upload-acceptance-video.mjs';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acc-video-'));
}

afterEach(() => {
  vi.restoreAllMocks();
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
});

describe('uploadAcceptanceVideo', () => {
  it('POSTs multipart to the publish endpoint with a bearer token', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'v.webm');
    fs.writeFileSync(video, 'bytes');

    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ evidence: { id: 'ev1' } }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await uploadAcceptanceVideo({
      baseUrl: 'https://app.motir.co/',
      token: 'motir_pat_abc',
      storyKey: 'MOTIR-1627',
      artifacts: { video, trace: null, chapters: null },
      provenance: { commitSha: 'abc', ciRunUrl: null, producedByKey: 'MOTIR-1638' },
    });

    expect(result).toEqual({ evidence: { id: 'ev1' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://app.motir.co/api/work-items/MOTIR-1627/acceptance-evidence');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer motir_pat_abc');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('commitSha')).toBe('abc');
  });

  it('uses keyless OIDC headers (marker + OIDC bearer) when an oidcToken is given', async () => {
    const dir = tmpDir();
    const video = path.join(dir, 'v.webm');
    fs.writeFileSync(video, 'bytes');

    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ evidence: { id: 'ev2' } }) });
    vi.stubGlobal('fetch', fetchMock);

    await uploadAcceptanceVideo({
      baseUrl: 'https://app.motir.co',
      oidcToken: 'oidc.jwt.token',
      storyKey: 'MOTIR-1627',
      artifacts: { video, trace: null, chapters: null },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.authorization).toBe('Bearer oidc.jwt.token');
    expect(init.headers['x-motir-auth']).toBe('github-oidc');
  });

  it('throws on a non-2xx response', async () => {
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
