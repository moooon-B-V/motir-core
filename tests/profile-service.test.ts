import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { truncateAuthTables } from './helpers/db';
import { createTestUser } from './fixtures/userFixtures';
import {
  InvalidAvatarUrlError,
  InvalidProfileNameError,
  UserNotFoundError,
} from '@/lib/users/errors';
import { FileTooLargeError, UnsupportedFileTypeError } from '@/lib/blob/errors';

// Profile read + update service tests (Story 8.8 · Subtask 8.8.21) against a
// REAL Postgres. The Blob adapter is the ONE mocked external (no network) —
// the same sanctioned exception attachments-service.test.ts uses — so the
// avatar GC (the delete of a replaced object) and the upload write are
// assertable without touching object storage. The mock returns the object KEY,
// which is what `putPublicAsset` returns since MOTIR-2404.
//
// Two storage forms appear below and both are deliberate: a KEY is what is
// written today, and the CONFIGURED-origin absolute URL is what rows written
// before MOTIR-2404 still carry. The read tolerance for the second is what let
// the storage change ship with no backfill, so it is covered here rather than
// assumed. (A third — an absolute URL on the retired Vercel public host — was
// dropped with the rest of the abandoned path by MOTIR-2393, against a measured
// ZERO rows with a non-null `image`.)
const PUBLIC_BASE = 'https://s3.test.invalid/motir-public';

vi.mock('@/lib/blob/uploader', () => ({
  putPublicAsset: vi.fn(async (pathname: string) => ({ key: pathname })),
  deletePublicAsset: vi.fn(async () => {}),
}));

const { usersService } = await import('@/lib/services/usersService');
const { MAX_PROFILE_NAME_LENGTH } = await import('@/lib/services/usersService');
const { putPublicAsset, deletePublicAsset } = await import('@/lib/blob/uploader');

/** What `User.image` holds for our own avatars: a bare object key. */
const ownAvatarKey = (userId: string, name: string) => `avatars/${userId}/${name}`;

/** What the DTO carries for that key — the key resolved against the public base. */
const resolved = (key: string) => `${PUBLIC_BASE}/${key}`;

/** A pre-MOTIR-2404 row: the same object, stored as an absolute URL. */
const absoluteAvatarUrl = (userId: string, name: string) =>
  `${PUBLIC_BASE}/avatars/${userId}/${name}`;

const fileOf = (name: string, type: string, bytes = 8) =>
  new File([new Uint8Array(bytes)], name, { type });

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('usersService.updateProfile — name', () => {
  it('updates the name and reads it back through the profile DTO', async () => {
    const user = await createTestUser({ name: 'Old Name', email: 'p1@example.com' });

    const dto = await usersService.updateProfile(user.id, { name: '  New Name  ' });

    // Trimmed on write; round-trips through the DTO (name + email + image:null).
    expect(dto).toEqual({
      id: user.id,
      name: 'New Name',
      email: 'p1@example.com',
      image: null,
    });
    const read = await usersService.getProfile(user.id);
    expect(read?.name).toBe('New Name');
    expect(read?.email).toBe('p1@example.com');
    expect(read?.image).toBeNull();
    expect(deletePublicAsset).not.toHaveBeenCalled();
  });

  it('rejects an empty / whitespace-only name and writes nothing', async () => {
    const user = await createTestUser({ name: 'Keep Me' });

    await expect(usersService.updateProfile(user.id, { name: '   ' })).rejects.toBeInstanceOf(
      InvalidProfileNameError,
    );
    await expect(usersService.updateProfile(user.id, { name: '' })).rejects.toBeInstanceOf(
      InvalidProfileNameError,
    );

    expect((await usersService.getProfile(user.id))?.name).toBe('Keep Me');
  });

  it('rejects a name longer than the bound', async () => {
    const user = await createTestUser();
    await expect(
      usersService.updateProfile(user.id, { name: 'x'.repeat(MAX_PROFILE_NAME_LENGTH + 1) }),
    ).rejects.toBeInstanceOf(InvalidProfileNameError);
  });

  it('leaves the avatar untouched when only the name is updated', async () => {
    const user = await createTestUser();
    const key = ownAvatarKey(user.id, 'a.png');
    await usersService.updateProfile(user.id, { image: key });
    vi.clearAllMocks();

    const dto = await usersService.updateProfile(user.id, { name: 'Renamed' });
    expect(dto.image).toBe(resolved(key));
    expect(deletePublicAsset).not.toHaveBeenCalled();
  });

  it('throws UserNotFoundError for an unknown user id', async () => {
    await expect(
      usersService.updateProfile('does-not-exist', { name: 'x' }),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

describe('usersService.updateProfile — avatar', () => {
  it('stores the KEY and returns it RESOLVED — no origin reaches the column', async () => {
    const user = await createTestUser();
    const key = ownAvatarKey(user.id, 'me.png');

    const dto = await usersService.updateProfile(user.id, { image: key });

    // The DTO is unchanged in shape: consumers still receive an absolute URL.
    expect(dto.image).toBe(resolved(key));
    expect((await usersService.getProfile(user.id))?.image).toBe(resolved(key));

    // The point of the card, asserted on the STORED value rather than the
    // response: no scheme, no host — nothing a hosting change could strand.
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.image).toBe(key);
    expect(stored.image).not.toMatch(/^https?:/);
  });

  it('resolution follows the configured base, so a bucket move needs no data change', async () => {
    const user = await createTestUser();
    const key = ownAvatarKey(user.id, 'moved.png');
    await usersService.updateProfile(user.id, { image: key });

    // The whole reason for storing a key: point the app at a different origin
    // and every existing avatar follows, with no migration.
    vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', 'https://cdn.elsewhere.test/bucket');
    expect((await usersService.getProfile(user.id))?.image).toBe(
      'https://cdn.elsewhere.test/bucket/' + key,
    );
  });

  it('accepts a pre-MOTIR-2404 ABSOLUTE row, passes it through, and still GCs it', async () => {
    const user = await createTestUser();
    const legacy = absoluteAvatarUrl(user.id, 'old.png');
    await db.user.update({ where: { id: user.id }, data: { image: legacy } });

    // Read tolerance: an absolute value is returned untouched, never re-prefixed.
    expect((await usersService.getProfile(user.id))?.image).toBe(legacy);

    // And it is still recognised as ours, so replacing it collects the object —
    // by KEY, which is what the column holds today.
    const next = ownAvatarKey(user.id, 'new.png');
    await usersService.updateProfile(user.id, { image: next });
    expect(deletePublicAsset).toHaveBeenCalledWith('avatars/' + user.id + '/old.png');
  });

  it('rejects a foreign URL, another user\u2019s key, and a traversal escape', async () => {
    const user = await createTestUser();
    const reject = (image: string) =>
      expect(usersService.updateProfile(user.id, { image })).rejects.toBeInstanceOf(
        InvalidAvatarUrlError,
      );

    await reject('https://evil.example.com/x.png');
    // Another user's prefix, in BOTH storage forms.
    await reject(ownAvatarKey('someone-else', 'x.png'));
    await reject(absoluteAvatarUrl('someone-else', 'x.png'));
    // An own-prefix path on an origin that is not the configured public bucket
    // is somebody else's object — the arm that used to accept the retired
    // platform's host is gone (MOTIR-2393).
    await reject(`https://teststore.public.store.invalid/avatars/${user.id}/x.png`);
    // The containment trap the gate's own comment names: a filename that merely
    // CONTAINS our prefix must not read as ours.
    await reject('avatars/someone-else/x-avatars-' + user.id + '-y.png');
    // A relative value that escapes its own prefix, and a non-https scheme that
    // would otherwise survive to an <img src>.
    await reject('avatars/' + user.id + '/../someone-else/x.png');
    await reject('/avatars/' + user.id + '/x.png');
    await reject('javascript:alert(1)//avatars/' + user.id + '/x.png');

    expect((await usersService.getProfile(user.id))?.image).toBeNull();
    expect(deletePublicAsset).not.toHaveBeenCalled();
  });

  it('replacing an avatar deletes the prior object BY KEY', async () => {
    const user = await createTestUser();
    const first = ownAvatarKey(user.id, 'first.png');
    const second = ownAvatarKey(user.id, 'second.png');

    await usersService.updateProfile(user.id, { image: first });
    vi.clearAllMocks();

    const dto = await usersService.updateProfile(user.id, { image: second });
    expect(dto.image).toBe(resolved(second));
    expect(deletePublicAsset).toHaveBeenCalledTimes(1);
    // A key, not a URL — deletePublicAsset no longer derives one.
    expect(deletePublicAsset).toHaveBeenCalledWith(first);
  });

  it('removing an avatar (image: null) deletes the prior object and nulls the column', async () => {
    const user = await createTestUser();
    const key = ownAvatarKey(user.id, 'gone.png');
    await usersService.updateProfile(user.id, { image: key });
    vi.clearAllMocks();

    const dto = await usersService.updateProfile(user.id, { image: null });
    expect(dto.image).toBeNull();
    expect((await usersService.getProfile(user.id))?.image).toBeNull();
    expect(deletePublicAsset).toHaveBeenCalledWith(key);
  });

  it('never deletes a foreign / OAuth provider avatar when it is replaced', async () => {
    const user = await createTestUser();
    // Simulate an OAuth signup whose image is a Google-hosted URL (not our blob).
    const google = 'https://lh3.googleusercontent.com/a/abc123';
    await db.user.update({ where: { id: user.id }, data: { image: google } });

    const key = ownAvatarKey(user.id, 'now-ours.png');
    const dto = await usersService.updateProfile(user.id, { image: key });
    expect(dto.image).toBe(resolved(key));
    // The Google URL is not one of ours → must NOT be deleted, and it is also
    // never re-prefixed on read: a provider avatar keeps working untouched.
    expect(deletePublicAsset).not.toHaveBeenCalled();
  });
});

describe('usersService.uploadAvatar', () => {
  it('stores under the per-user avatars prefix and returns the KEY', async () => {
    const user = await createTestUser();

    const { key } = await usersService.uploadAvatar(fileOf('pic.png', 'image/png'), user.id);

    expect(putPublicAsset).toHaveBeenCalledWith(
      `avatars/${user.id}/pic.png`,
      expect.anything(),
      'image/png',
    );
    expect(key).toBe(ownAvatarKey(user.id, 'pic.png'));
    expect(key).not.toMatch(/^https?:/);
    // The round trip the Profile pane actually performs: upload -> PATCH the
    // returned value -> the DTO carries the resolved URL the field renders.
    await expect(usersService.updateProfile(user.id, { image: key })).resolves.toMatchObject({
      image: resolved(key),
    });
  });

  it('rejects a non-image MIME type', async () => {
    const user = await createTestUser();
    await expect(
      usersService.uploadAvatar(fileOf('doc.pdf', 'application/pdf'), user.id),
    ).rejects.toBeInstanceOf(UnsupportedFileTypeError);
    expect(putPublicAsset).not.toHaveBeenCalled();
  });

  it('rejects an oversized file before touching storage', async () => {
    const user = await createTestUser();
    const huge = new File([new Uint8Array(11 * 1024 * 1024)], 'big.png', { type: 'image/png' });
    await expect(usersService.uploadAvatar(huge, user.id)).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    expect(putPublicAsset).not.toHaveBeenCalled();
  });
});
