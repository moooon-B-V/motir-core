import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
// avatar GC (`del` of a replaced blob) and the upload write are assertable
// without touching Vercel Blob. The mock returns a URL on OUR public-blob host
// so an uploaded avatar passes updateProfile's own-avatar gate end-to-end.
const TEST_BLOB_HOST = 'teststore.public.blob.vercel-storage.com';

vi.mock('@/lib/blob/uploader', () => ({
  putPublicAsset: vi.fn(async (pathname: string) => ({
    url: `https://${TEST_BLOB_HOST}/${pathname}`,
  })),
  deletePublicAsset: vi.fn(async () => {}),
}));

const { usersService } = await import('@/lib/services/usersService');
const { MAX_PROFILE_NAME_LENGTH } = await import('@/lib/services/usersService');
const { putPublicAsset, deletePublicAsset } = await import('@/lib/blob/uploader');

/** An own-avatar URL the gate accepts: our blob host + `/avatars/<userId>/`. */
const ownAvatarUrl = (userId: string, name: string) =>
  `https://${TEST_BLOB_HOST}/avatars/${userId}/${name}`;

const fileOf = (name: string, type: string, bytes = 8) =>
  new File([new Uint8Array(bytes)], name, { type });

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAuthTables();
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
    const avatar = ownAvatarUrl(user.id, 'a.png');
    await usersService.updateProfile(user.id, { image: avatar });
    vi.clearAllMocks();

    const dto = await usersService.updateProfile(user.id, { name: 'Renamed' });
    expect(dto.image).toBe(avatar);
    expect(deletePublicAsset).not.toHaveBeenCalled();
  });

  it('throws UserNotFoundError for an unknown user id', async () => {
    await expect(
      usersService.updateProfile('does-not-exist', { name: 'x' }),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

describe('usersService.updateProfile — avatar', () => {
  it('sets a valid own-avatar URL and round-trips it through the DTO', async () => {
    const user = await createTestUser();
    const avatar = ownAvatarUrl(user.id, 'me.png');

    const dto = await usersService.updateProfile(user.id, { image: avatar });
    expect(dto.image).toBe(avatar);
    expect((await usersService.getProfile(user.id))?.image).toBe(avatar);
  });

  it('rejects a non-referenced (foreign) image URL and writes nothing', async () => {
    const user = await createTestUser();

    await expect(
      usersService.updateProfile(user.id, { image: 'https://evil.example.com/x.png' }),
    ).rejects.toBeInstanceOf(InvalidAvatarUrlError);
    // A blob on our host but under ANOTHER user's prefix is equally rejected.
    await expect(
      usersService.updateProfile(user.id, { image: ownAvatarUrl('someone-else', 'x.png') }),
    ).rejects.toBeInstanceOf(InvalidAvatarUrlError);

    expect((await usersService.getProfile(user.id))?.image).toBeNull();
    expect(deletePublicAsset).not.toHaveBeenCalled();
  });

  it('replacing an avatar deletes the prior blob', async () => {
    const user = await createTestUser();
    const first = ownAvatarUrl(user.id, 'first.png');
    const second = ownAvatarUrl(user.id, 'second.png');

    await usersService.updateProfile(user.id, { image: first });
    vi.clearAllMocks();

    const dto = await usersService.updateProfile(user.id, { image: second });
    expect(dto.image).toBe(second);
    expect(deletePublicAsset).toHaveBeenCalledTimes(1);
    expect(deletePublicAsset).toHaveBeenCalledWith(first);
  });

  it('removing an avatar (image: null) deletes the prior blob and nulls the column', async () => {
    const user = await createTestUser();
    const avatar = ownAvatarUrl(user.id, 'gone.png');
    await usersService.updateProfile(user.id, { image: avatar });
    vi.clearAllMocks();

    const dto = await usersService.updateProfile(user.id, { image: null });
    expect(dto.image).toBeNull();
    expect((await usersService.getProfile(user.id))?.image).toBeNull();
    expect(deletePublicAsset).toHaveBeenCalledWith(avatar);
  });

  it('never deletes a foreign / OAuth provider avatar when it is replaced', async () => {
    const user = await createTestUser();
    // Simulate an OAuth signup whose image is a Google-hosted URL (not our blob).
    const google = 'https://lh3.googleusercontent.com/a/abc123';
    await db.user.update({ where: { id: user.id }, data: { image: google } });

    const dto = await usersService.updateProfile(user.id, {
      image: ownAvatarUrl(user.id, 'now-ours.png'),
    });
    expect(dto.image).toBe(ownAvatarUrl(user.id, 'now-ours.png'));
    // The Google URL is not one of our blobs → must NOT be sent to `del`.
    expect(deletePublicAsset).not.toHaveBeenCalled();
  });
});

describe('usersService.uploadAvatar', () => {
  it('stores an image under the per-user avatars prefix and returns its URL', async () => {
    const user = await createTestUser();

    const { url } = await usersService.uploadAvatar(fileOf('pic.png', 'image/png'), user.id);

    expect(putPublicAsset).toHaveBeenCalledWith(
      `avatars/${user.id}/pic.png`,
      expect.anything(),
      'image/png',
    );
    // The returned URL is one updateProfile will accept for this user.
    expect(url).toBe(ownAvatarUrl(user.id, 'pic.png'));
    await expect(usersService.updateProfile(user.id, { image: url })).resolves.toMatchObject({
      image: url,
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
