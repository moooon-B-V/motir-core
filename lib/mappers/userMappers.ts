import type { User } from '@prisma/client';
import type { UserProfileDto } from '@/lib/dto/users';

// User Prisma → DTO converters (CLAUDE.md 4-layer: mappers live here, services
// call them just before returning).

/** Project a Prisma `User` to the display-safe {@link UserProfileDto}. */
export function toUserProfileDto(user: User): UserProfileDto {
  return {
    id: user.id,
    name: user.name ?? '',
    email: user.email,
  };
}
