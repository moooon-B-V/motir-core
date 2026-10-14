// A LOCAL SENTRY INGEST for the observability lane (MOTIR-8557).
//
// The lane's server runs the REAL Sentry SDK with its DSN pointed here
// (`http://e2e@127.0.0.1:<port>/1`), so what lands in the capture file is the
// bytes the SDK would have sent to sentry.io: real envelopes, serialised by the
// real transport over a real socket. Nothing in the SDK is mocked.
//
// Shared with the spec workers through a FILE, the way `EMAIL_OUTBOX_PATH` is:
// the server below runs in the Playwright RUNNER (started by the lane's
// globalSetup), and the specs run in worker processes.
//
// One JSON line per envelope ITEM: `{ type, envelopeHeader, payload, raw }`.
// `raw` is the item's own text exactly as received, so a "nothing bound leaks"
// assertion can read the file's raw text and see every byte the SDK sent.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';

export interface CapturedItem {
  type: string;
  envelopeHeader: Record<string, unknown>;
  payload: unknown;
  raw: string;
}

/** Split one envelope body into its items. Sentry's envelope format: a header
 *  line, then per item a header line and a payload that is `length` bytes when
 *  the item header says so, else the rest of the line. */
export function parseEnvelope(body: Buffer): {
  header: Record<string, unknown>;
  items: { type: string; payload: unknown; raw: string }[];
} {
  let offset = 0;
  const readLine = (): Buffer => {
    const end = body.indexOf(0x0a, offset);
    const line = body.subarray(offset, end === -1 ? body.length : end);
    offset = end === -1 ? body.length : end + 1;
    return line;
  };
  const header = JSON.parse(readLine().toString('utf8') || '{}') as Record<string, unknown>;
  const items: { type: string; payload: unknown; raw: string }[] = [];
  while (offset < body.length) {
    const headerLine = readLine().toString('utf8');
    if (!headerLine.trim()) continue;
    const itemHeader = JSON.parse(headerLine) as { type?: string; length?: number };
    let payloadBytes: Buffer;
    if (typeof itemHeader.length === 'number') {
      payloadBytes = body.subarray(offset, offset + itemHeader.length);
      offset += itemHeader.length;
      if (body[offset] === 0x0a) offset += 1;
    } else {
      payloadBytes = readLine();
    }
    const raw = payloadBytes.toString('utf8');
    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      // A non-JSON item (an attachment) is kept as its text.
    }
    items.push({ type: itemHeader.type ?? 'unknown', payload, raw: `${headerLine}\n${raw}` });
  }
  return { header, items };
}

/** Start the ingest on `port`, appending every item it receives to `file`. */
export async function startSentryCapture(port: number, file: string): Promise<Server> {
  clearCaptured(file);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        if (req.method === 'POST' && /^\/api\/[^/]+\/envelope\/?/.test(req.url ?? '')) {
          let body = Buffer.concat(chunks);
          if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
          const { header, items } = parseEnvelope(body);
          for (const item of items) {
            appendFileSync(file, `${JSON.stringify({ ...item, envelopeHeader: header })}\n`);
          }
        }
      } catch (err) {
        // Recorded rather than thrown: an unparseable envelope is a finding the
        // spec should see, not a crash of the runner.
        appendFileSync(
          file,
          `${JSON.stringify({ type: 'capture_error', envelopeHeader: {}, payload: String(err), raw: '' })}\n`,
        );
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}

export async function stopSentryCapture(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Every item captured so far. */
export function readCaptured(file: string): CapturedItem[] {
  return readCapturedText(file)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CapturedItem);
}

/** The capture file's raw text — what the "nothing bound leaks" check reads. */
export function readCapturedText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export function clearCaptured(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
}
