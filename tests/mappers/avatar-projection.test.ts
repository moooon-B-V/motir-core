import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { toUserProfileDto } from '@/lib/mappers/userMappers';
import { toWatcherDto } from '@/lib/mappers/watcherMappers';
import { toAttachmentDto } from '@/lib/mappers/attachmentMappers';

// The PROJECTION seam of MOTIR-2404 (`User.image` stores a key, DTOs carry a
// URL), asserted where it is easiest to break.
//
// `image` is copied verbatim by roughly ten independent mappers and services —
// there is no shared `toUserDto` and no shared Prisma `userSelect`, so the
// resolver had to be applied at each one by hand. The failure mode is therefore
// NOT "the resolver is wrong"; it is "one site was missed", and a missed site is
// invisible: the DTO still type-checks, the column still round-trips, and the
// only symptom is an <img> that silently does not paint. (One site WAS missed
// while writing the card — `attachmentMappers` — and the acceptance criterion's
// grep is what found it.)
//
// So these tests drive the mappers DIRECTLY with a key-stored user, a
// provider-stored user and a legacy-URL user, and assert the value that comes
// out is something a browser can fetch. They are cheap and they fail loudly the
// next time a mapper is added that forgets the resolver.

const PUBLIC_BASE = 'https://s3.test.invalid/motir-public';
const KEY = 'avatars/u1/me.png';
const GOOGLE = 'https://lh3.googleusercontent.com/a/abc123';
const LEGACY = 'https://store1.public.blob.vercel-storage.com/avatars/u1/old.png';

const userWith = (image: string | null): User =>
  ({
    id: 'u1',
    name: 'Ada',
    email: 'ada@example.com',
    emailVerified: true,
    image,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }) as unknown as User;

beforeEach(() => {
  vi.stubEnv('MOTIR_S3_PUBLIC_BASE_URL', PUBLIC_BASE);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('every user-image projection hands its consumer an ABSOLUTE url', () => {
  // Each entry is one projection site, named so a failure says which one.
  const projections: ReadonlyArray<readonly [string, (u: User) => string | null]> = [
    ['userMappers.toUserProfileDto', (u) => toUserProfileDto(u).image],
    [
      'watcherMappers.toWatcherDto',
      (u) => toWatcherDto({ userId: u.id, user: u } as never).image ?? null,
    ],
    [
      'attachmentMappers.toAttachmentDto',
      (u) =>
        toAttachmentDto(
          {
            id: 'a1',
            workspaceId: 'w1',
            workItemId: 'i1',
            commentId: null,
            uploaderUserId: u.id,
            filename: 'f.png',
            mimeType: 'image/png',
            sizeBytes: 1,
            blobPathname: 'attachments/w1/f.png',
            createdAt: new Date(0),
          } as never,
          new Map([[u.id, u]]),
        ).uploader?.image ?? null,
    ],
  ];

  for (const [name, project] of projections) {
    it(`${name} resolves a stored KEY against the public base`, () => {
      expect(project(userWith(KEY))).toBe(`${PUBLIC_BASE}/${KEY}`);
    });

    it(`${name} leaves a PROVIDER url untouched`, () => {
      // A Google avatar is written by better-auth's adapter, which this repo
      // does not own — re-prefixing it would break every OAuth user.
      expect(project(userWith(GOOGLE))).toBe(GOOGLE);
    });

    it(`${name} leaves a LEGACY absolute row untouched`, () => {
      // This is the arm that made the storage change safe with no backfill.
      expect(project(userWith(LEGACY))).toBe(LEGACY);
    });

    it(`${name} passes a null image through`, () => {
      expect(project(userWith(null))).toBeNull();
    });
  }
});
