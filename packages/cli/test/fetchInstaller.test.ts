import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `fetch_installer` (MOTIR-6495) — the download-and-verify step every sandbox
// install arm puts a vendor's install SCRIPT through, instead of piping it into
// bash.
//
// The failure it exists for: the antigravity profile went red on CI three times
// in a day with `bash: line 1: syntax error near unexpected token ')'`, and the
// bytes bash quoted back began `1f 8b 08` — a gzip body with a 200 status that
// `curl -f` passed straight to the shell. So the cases below are driven against
// a real HTTP server and a real bash, not asserted on the script's text: the
// point is what the helper DOES with a body, and a text match cannot say.
//
// Async `execFile`, never `spawnSync`: the stub server lives in this process,
// and a synchronous child would block the event loop it answers on.

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', 'sandbox', 'fetch-installer.sh');

const SCRIPT = '#!/usr/bin/env bash\nset -euo pipefail\necho "installed $*"\n';

let server: Server;
let base: string;
let dir: string;
const hits = new Map<string, number>();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fetch-installer-'));
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    const hit = (hits.get(path) ?? 0) + 1;
    hits.set(path, hit);
    switch (path) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/x-sh' }).end(SCRIPT);
        return;
      // The shape CI received: compressed, 200, and NOT marked as compressed.
      case '/gzip-unmarked':
        res.writeHead(200, { 'content-type': 'text/x-sh' }).end(gzipSync(SCRIPT));
        return;
      // Marked compressed — `curl --compressed` decodes this one itself.
      case '/gzip-marked':
        res
          .writeHead(200, { 'content-type': 'text/x-sh', 'content-encoding': 'gzip' })
          .end(gzipSync(SCRIPT));
        return;
      case '/html':
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<!doctype html><html><body>Oops</body></html>');
        return;
      case '/not-bash':
        res.writeHead(200, { 'content-type': 'text/x-sh' }).end('#!/usr/bin/env bash\nif then (\n');
        return;
      case '/corrupt-gzip':
        res.writeHead(200).end(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]));
        return;
      // A vendor hiccup: garbage on the first request, the script after it.
      case '/flaky':
        if (hit === 1) res.writeHead(200).end('<html>temporarily unavailable</html>');
        else res.writeHead(200, { 'content-type': 'text/x-sh' }).end(SCRIPT);
        return;
      default:
        res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

interface Outcome {
  code: number;
  stderr: string;
  dest: string;
}

/** Source the helper under the same `set -euo pipefail` install-agent.sh runs with. */
function fetchInstaller(path: string, name: string): Promise<Outcome> {
  const dest = join(dir, name);
  return new Promise((resolve) => {
    execFile(
      'bash',
      [
        '-c',
        'set -euo pipefail; . "$1"; fetch_installer "$2" "$3"',
        '_',
        HELPER,
        `${base}${path}`,
        dest,
      ],
      // No backoff sleep in the suite; three attempts, as in the image.
      { env: { ...process.env, MOTIR_INSTALLER_BACKOFF: '0', MOTIR_INSTALLER_ATTEMPTS: '3' } },
      (error, _stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stderr, dest });
      },
    );
  });
}

describe('fetch_installer — a vendor install script is checked before anything runs it', () => {
  it('accepts a plain script', async () => {
    const r = await fetchInstaller('/ok', 'ok.sh');
    expect(r.code).toBe(0);
    expect(readFileSync(r.dest, 'utf8')).toBe(SCRIPT);
    expect(r.stderr).toBe('');
  });

  it('decodes a gzip body the server did NOT mark as compressed — the body CI received', async () => {
    const r = await fetchInstaller('/gzip-unmarked', 'unmarked.sh');
    expect(r.code).toBe(0);
    expect(readFileSync(r.dest, 'utf8')).toBe(SCRIPT);
  });

  it('decodes a gzip body the server DID mark as compressed', async () => {
    const r = await fetchInstaller('/gzip-marked', 'marked.sh');
    expect(r.code).toBe(0);
    expect(readFileSync(r.dest, 'utf8')).toBe(SCRIPT);
  });

  it('retries a bad response and succeeds when the vendor recovers', async () => {
    const r = await fetchInstaller('/flaky', 'flaky.sh');
    expect(r.code).toBe(0);
    expect(readFileSync(r.dest, 'utf8')).toBe(SCRIPT);
    expect(hits.get('/flaky')).toBe(2);
    expect(r.stderr).toContain(`installer attempt 1/3 for ${base}/flaky failed`);
  });

  it('refuses a page that is not a script, naming the URL and what came back', async () => {
    const r = await fetchInstaller('/html', 'html.sh');
    expect(r.code).not.toBe(0);
    expect(hits.get('/html')).toBe(3);
    expect(r.stderr).toContain(`the installer at ${base}/html was not usable after 3 attempts`);
    expect(r.stderr).toContain('no #! shebang');
    expect(r.stderr).toContain('<!doctype html>');
    // Never a bash syntax error: nothing was executed.
    expect(r.stderr).not.toContain('syntax error near unexpected token');
    expect(existsSync(r.dest)).toBe(false);
  });

  it('refuses a script bash cannot parse', async () => {
    const r = await fetchInstaller('/not-bash', 'not-bash.sh');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('bash -n rejects it');
    expect(existsSync(r.dest)).toBe(false);
  });

  it('refuses a gzip body that does not decompress', async () => {
    const r = await fetchInstaller('/corrupt-gzip', 'corrupt.sh');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('a gzip body that does not decompress');
  });

  it('reports an HTTP error as curl failing, with the URL', async () => {
    const r = await fetchInstaller('/missing', 'missing.sh');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(`the installer at ${base}/missing was not usable`);
    expect(r.stderr).toContain('curl failed');
  });
});
