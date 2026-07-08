import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The two-store blob adapter (MOTIR-1665). Mocks `@vercel/blob` at the module
// boundary so nothing hits the network — this asserts the adapter wiring
// (which store/access/token each path uses, and the private signing flow),
// not the SDK itself.
vi.mock('@vercel/blob', () => ({
  put: vi.fn(),
  del: vi.fn(),
  issueSignedToken: vi.fn(),
  presignUrl: vi.fn(),
}));

import { put, issueSignedToken, presignUrl } from '@vercel/blob';
import { putPublicAsset, putPrivateAttachment, signedDownloadUrl } from '@/lib/blob/uploader';

const putMock = vi.mocked(put);
const issueSignedTokenMock = vi.mocked(issueSignedToken);
const presignUrlMock = vi.mocked(presignUrl);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  delete process.env.BLOB_PUBLIC_READ_WRITE_TOKEN;
});

describe('putPublicAsset', () => {
  it('uploads public, to the PUBLIC-store token, and returns the URL', async () => {
    process.env.BLOB_PUBLIC_READ_WRITE_TOKEN = 'pub-token';
    putMock.mockResolvedValue({ url: 'https://pub.example/a-x.png' } as never);

    const result = await putPublicAsset('avatars/a.png', new Blob(['x']), 'image/png');

    expect(result).toEqual({ url: 'https://pub.example/a-x.png' });
    expect(putMock).toHaveBeenCalledWith(
      'avatars/a.png',
      expect.anything(),
      expect.objectContaining({
        access: 'public',
        token: 'pub-token',
        addRandomSuffix: true,
        contentType: 'image/png',
      }),
    );
  });
});

describe('putPrivateAttachment', () => {
  it('uploads private (default token) and returns the PATHNAME, not a URL', async () => {
    putMock.mockResolvedValue({
      pathname: 'acceptance/w/s/v-x.webm',
      url: 'https://priv.example/should-not-be-used',
    } as never);

    const result = await putPrivateAttachment(
      'acceptance/w/s/v.webm',
      new Blob(['x']),
      'video/webm',
    );

    expect(result).toEqual({ pathname: 'acceptance/w/s/v-x.webm' });
    expect(result).not.toHaveProperty('url');
    const opts = putMock.mock.calls[0]![2] as unknown as Record<string, unknown>;
    expect(opts).toMatchObject({ access: 'private', addRandomSuffix: true });
    // The private path never targets the public-store token.
    expect(opts).not.toHaveProperty('token');
  });
});

describe('signedDownloadUrl', () => {
  it('mints a short-lived signed GET url via issueSignedToken → presignUrl', async () => {
    issueSignedTokenMock.mockResolvedValue({
      clientSigningToken: 'c',
      delegationToken: 'd',
      validUntil: 1,
    } as never);
    presignUrlMock.mockResolvedValue({
      presignedUrl: 'https://priv.example/signed?sig=1',
    } as never);

    const url = await signedDownloadUrl('acceptance/w/s/v-x.webm', { ttlSeconds: 300 });

    expect(url).toBe('https://priv.example/signed?sig=1');
    expect(issueSignedTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: 'acceptance/w/s/v-x.webm', operations: ['get'] }),
    );
    expect(presignUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientSigningToken: 'c', delegationToken: 'd' }),
      expect.objectContaining({
        operation: 'get',
        pathname: 'acceptance/w/s/v-x.webm',
        access: 'private',
      }),
    );
  });

  it('appends the ?download=1 content-disposition switch when downloading', async () => {
    issueSignedTokenMock.mockResolvedValue({
      clientSigningToken: 'c',
      delegationToken: 'd',
      validUntil: 1,
    } as never);
    presignUrlMock.mockResolvedValue({
      presignedUrl: 'https://priv.example/signed?sig=1',
    } as never);

    const url = await signedDownloadUrl('attachments/w/archive.zip', { download: true });

    expect(url).toBe('https://priv.example/signed?sig=1&download=1');
  });
});
