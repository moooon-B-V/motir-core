import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentContentPath,
  avatarBlobPrefix,
  extractReferencedAttachmentIds,
  extractReferencedAttachmentIdsFromBodies,
  isOwnAvatarRef,
  storedAssetKey,
  storedAssetUrl,
} from '@/lib/blob/referencedUrls';

// Pure-parser tests for the link-on-write ID extractor (Subtask 5.2.3; id-based
// since MOTIR-1668). No DB: string work only; the DB half (workspace-scoped
// linking) is tests/attachments/link-on-write.test.ts. Content attachments are
// PRIVATE and embed as their authenticated content path
// `/api/attachments/<id>/content` — tenancy is enforced at the DB, not here, so
// a foreign id would extract but can never link.

const cp = (id: string) => attachmentContentPath(id);

describe('extractReferencedAttachmentIds', () => {
  it('extracts image embeds, file links, and bare pastes of content paths', () => {
    const a = 'aaa111';
    const b = 'bbb222';
    const c = 'ccc333';
    const body = `Intro ![shot](${cp(a)}) then [the spec](${cp(b)}) and bare ${cp(c)} end.`;
    expect(extractReferencedAttachmentIds(body)).toEqual([a, b, c]);
  });

  it('dedupes repeated references in first-seen order', () => {
    const a = 'onea11';
    const b = 'twob22';
    const body = `![x](${cp(a)}) ![y](${cp(b)}) again ![z](${cp(a)})`;
    expect(extractReferencedAttachmentIds(body)).toEqual([a, b]);
  });

  it('ignores non-content attachment paths and other app routes', () => {
    const body =
      `[thumb](/api/attachments/xyz789/thumbnail) ` +
      `[item](/api/work-items/wi12345/content) ` +
      `[plain](https://example.com/pic.png)`;
    expect(extractReferencedAttachmentIds(body)).toEqual([]);
  });

  it('null / undefined / empty / path-free bodies extract to []', () => {
    expect(extractReferencedAttachmentIds(null)).toEqual([]);
    expect(extractReferencedAttachmentIds(undefined)).toEqual([]);
    expect(extractReferencedAttachmentIds('')).toEqual([]);
    expect(extractReferencedAttachmentIds('plain prose, no links')).toEqual([]);
  });
});

describe('extractReferencedAttachmentIdsFromBodies', () => {
  it('merges several bodies, deduped in first-seen order, skipping null bodies', () => {
    const a = 'a11aaa';
    const b = 'b22bbb';
    expect(
      extractReferencedAttachmentIdsFromBodies([
        `![x](${cp(a)})`,
        null,
        `![y](${cp(b)}) ![x](${cp(a)})`,
      ]),
    ).toEqual([a, b]);
  });
});

// ── The stored-reference seam (MOTIR-2404) ───────────────────────────────────
// `User.image` holds the object KEY for our own avatars, an absolute URL for a
// provider avatar, and — for any row written earlier — an absolute URL on our
// own store. All three must round-trip: resolve for display, reduce to a key
// for the GC, and be gated to their owning user. These are the three functions
// that must agree about what a stored value MEANS; the whole no-backfill
// argument rests on them agreeing.

const PUBLIC_BASE = 'https://s3.test.invalid/motir-public';
const LEGACY = 'https://store1.public.blob.vercel-storage.com';
const GOOGLE = 'https://lh3.googleusercontent.com/a/abc123';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('storedAssetUrl — a stored reference becomes something a browser can fetch', () => {
  it('resolves a bare KEY against the configured public base', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(storedAssetUrl('avatars/u1/me.png')).toBe(`${PUBLIC_BASE}/avatars/u1/me.png`);
  });

  it('returns an ABSOLUTE value unchanged — provider avatar and legacy row alike', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    // The arm that makes a foreign avatar work is the same arm that makes a
    // pre-MOTIR-2404 row work, which is why this change needed no backfill.
    expect(storedAssetUrl(GOOGLE)).toBe(GOOGLE);
    expect(storedAssetUrl(`${LEGACY}/avatars/u1/old.png`)).toBe(`${LEGACY}/avatars/u1/old.png`);
    // ...and it is not double-prefixed by the configured base.
    expect(storedAssetUrl(`${PUBLIC_BASE}/avatars/u1/x.png`)).toBe(
      `${PUBLIC_BASE}/avatars/u1/x.png`,
    );
  });

  it('passes null/empty through rather than inventing a URL', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(storedAssetUrl(null)).toBeNull();
    expect(storedAssetUrl(undefined)).toBeNull();
    expect(storedAssetUrl('')).toBeNull();
  });

  it('degrades to the raw key when the store is unconfigured, never throws', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', '');
    // This runs inside DTO mappers on every read path, so an unconfigured store
    // must cost a broken image, not a 500 on the board.
    expect(() => storedAssetUrl('avatars/u1/me.png')).not.toThrow();
    expect(storedAssetUrl('avatars/u1/me.png')).toBe('avatars/u1/me.png');
  });

  it('joins without doubling or dropping a slash', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', `${PUBLIC_BASE}/`);
    expect(storedAssetUrl('avatars/u1/me.png')).toBe(`${PUBLIC_BASE}/avatars/u1/me.png`);
  });
});

describe('storedAssetKey — the object the GC acts on', () => {
  it('reduces all three of OUR forms to the same key', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    const key = 'avatars/u1/me.png';
    expect(storedAssetKey(key)).toBe(key);
    expect(storedAssetKey(`${PUBLIC_BASE}/${key}`)).toBe(key);
    expect(storedAssetKey(`${LEGACY}/${key}`)).toBe(key);
  });

  it('yields null for anything that is not ours', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(storedAssetKey(GOOGLE)).toBeNull();
    expect(storedAssetKey(null)).toBeNull();
    expect(storedAssetKey('')).toBeNull();
  });
});

describe('isOwnAvatarRef — the gate, in both storage forms', () => {
  it('accepts the caller’s own key and own absolute URLs', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(isOwnAvatarRef(`${avatarBlobPrefix('u1')}me.png`, 'u1')).toBe(true);
    expect(isOwnAvatarRef(`${PUBLIC_BASE}/avatars/u1/me.png`, 'u1')).toBe(true);
    expect(isOwnAvatarRef(`${LEGACY}/avatars/u1/me.png`, 'u1')).toBe(true);
  });

  it('rejects another user’s object in either form', () => {
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
    expect(isOwnAvatarRef('avatars/u2/me.png', 'u1')).toBe(false);
    expect(isOwnAvatarRef(`${PUBLIC_BASE}/avatars/u2/me.png`, 'u1')).toBe(false);
  });

  it('rejects a filename that merely CONTAINS the caller’s prefix', () => {
    // The reason the check is startsWith and never includes: the key's tail is
    // a user-supplied filename.
    expect(isOwnAvatarRef('avatars/u2/x-avatars-u1-y.png', 'u1')).toBe(false);
  });

  it('rejects a relative value that escapes its own prefix', () => {
    expect(isOwnAvatarRef('avatars/u1/../u2/me.png', 'u1')).toBe(false);
    expect(isOwnAvatarRef('/avatars/u1/me.png', 'u1')).toBe(false);
  });

  it('rejects a non-https scheme that would otherwise reach an <img src>', () => {
    // `javascript:`/`data:` parse perfectly well as URLs — the protocol check is
    // what stops one being stored and later rendered.
    expect(isOwnAvatarRef('javascript:alert(1)//avatars/u1/x.png', 'u1')).toBe(false);
    expect(isOwnAvatarRef('data:image/png;base64,AAAA', 'u1')).toBe(false);
    expect(
      isOwnAvatarRef('http://store1.public.blob.vercel-storage.com/avatars/u1/x.png', 'u1'),
    ).toBe(false);
  });

  it('rejects a foreign provider URL and empty input', () => {
    expect(isOwnAvatarRef(GOOGLE, 'u1')).toBe(false);
    expect(isOwnAvatarRef(null, 'u1')).toBe(false);
    expect(isOwnAvatarRef(undefined, 'u1')).toBe(false);
    expect(isOwnAvatarRef('', 'u1')).toBe(false);
  });
});
