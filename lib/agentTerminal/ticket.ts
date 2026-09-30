import { createHash, randomBytes } from 'node:crypto';

// THE TERMINAL TICKET'S BYTES (`docs/decisions/agent-terminal.md` Q3 ·
// MOTIR-6940): 32 random bytes as base64url, stored only as their SHA-256. A
// ticket is a credential — never logged, never in an Error message.

/** A fresh ticket: base64url of 32 random bytes (43 characters). */
export function mintTerminalTicket(): string {
  return randomBytes(32).toString('base64url');
}

/** The only form a ticket is stored or looked up in: hex SHA-256. */
export function hashTerminalTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}
