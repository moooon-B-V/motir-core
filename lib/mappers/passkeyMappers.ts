import type { Passkey } from '@/generated/prisma/client';
import type { PasskeyDTO } from '@/lib/dto/passkey';

// Prisma rows → the passkey DTO (Story MOTIR-1214 · Subtask MOTIR-3611).

/**
 * A `passkey` row → its DTO.
 *
 * The mapper is the boundary that DROPS the credential material: `publicKey`,
 * `credentialID`, `counter`, `transports` and `aaguid` are named on the row and
 * on no field below, so a later field addition to the model cannot leak into a
 * client payload by being spread through. That is why this is an explicit
 * five-field literal rather than a destructure-and-rest.
 *
 * `createdAt` crosses as an ISO string, not a `Date`: this shape is serialised
 * into a Server Component's props, and a `Date` does not survive that trip —
 * the reason `toTrustedDeviceDTO` already gives.
 */
export function toPasskeyDTO(row: Passkey): PasskeyDTO {
  return {
    id: row.id,
    name: row.name,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: row.createdAt.toISOString(),
  };
}
