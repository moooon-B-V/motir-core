// Keeping credentials out of every recorder's output (Story MOTIR-8538 · MOTIR-8683).

/**
 * `text` with each of `secrets` and any connection URL's credentials masked. A
 * recorder's failure message is written to disk, and a driver error can quote the
 * string it was given.
 */
export function redact(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, '$1[redacted]@');
}
