import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { uploadIssueAttachment } from '@/lib/blob/uploadClient';

// MOTIR-5133 — the editor's upload notice for a §4 cap refusal.
//
// The route answers a cap with 402 `{ code: 'ENTITLEMENT_EXCEEDED', error,
// entitlement, detail }`. The client used to map every `code` to
// `errors.upload.<code>`, and no catalogue has `upload.ENTITLEMENT_EXCEEDED` —
// the words depend on WHICH cap. It now selects the translated sentence by the
// body's `entitlement`, and never shows the server's English `error`.

const SERVER_ENGLISH = 'SERVER-SIDE ENGLISH — must never reach a reader';

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

const file = new File(['x'], 'big.png', { type: 'image/png' });
// The caller passes `useTranslations('errors')`; a translator over the real
// catalogue stands in for it, widened to the client's own `(key: string)` shape.
const enT = createTranslator({ locale: 'en', messages: enMessages, namespace: 'errors' });
const zhT = createTranslator({ locale: 'zh', messages: zhMessages, namespace: 'errors' });
const en = (key: string) => enT(key as Parameters<typeof enT>[0]);
const zh = (key: string) => zhT(key as Parameters<typeof zhT>[0]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadIssueAttachment — a 402 cap refusal', () => {
  it('throws the translated sentence for the refused kind, in the reader language', async () => {
    const refusal = {
      code: 'ENTITLEMENT_EXCEEDED',
      error: SERVER_ENGLISH,
      entitlement: 'storage',
      detail: { limit: 1 },
    };

    stubFetch(402, refusal);
    await expect(uploadIssueAttachment(file, zh)).rejects.toThrow(
      zhMessages.errors.entitlementExceeded.storage,
    );

    stubFetch(402, { ...refusal, entitlement: 'file_size' });
    await expect(uploadIssueAttachment(file, en)).rejects.toThrow(
      enMessages.errors.entitlementExceeded.file_size,
    );
  });

  it('an unknown entitlement falls back to the code path, never the server string', async () => {
    stubFetch(402, { code: 'RATE_LIMITED', error: SERVER_ENGLISH, entitlement: 'seats' });
    await expect(uploadIssueAttachment(file, en)).rejects.toThrow(
      enMessages.errors.upload.RATE_LIMITED,
    );
  });

  it('keeps mapping the per-code upload errors it always mapped', async () => {
    stubFetch(413, { code: 'FILE_TOO_LARGE', error: SERVER_ENGLISH });
    await expect(uploadIssueAttachment(file, zh)).rejects.toThrow(
      zhMessages.errors.upload.FILE_TOO_LARGE,
    );
  });
});
