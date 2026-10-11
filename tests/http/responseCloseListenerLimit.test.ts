import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  RESPONSE_CLOSE_LISTENER_LIMIT,
  installResponseCloseListenerLimit,
  uninstallResponseCloseListenerLimit,
} from '@/lib/http/responseCloseListenerLimit';

// MOTIR-8171 — a real HTTP server, because the behaviour under test is Node's
// own `http.server.response.created` channel and a fake would prove nothing.

async function addListeners(count: number): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const onWarning = (w: Error) => {
    if (w.name === 'MaxListenersExceededWarning') warnings.push(w.message);
  };
  process.on('warning', onWarning);
  const server = http.createServer((_req, res) => {
    for (let i = 0; i < count; i++) res.on('close', () => {});
    res.end('ok');
  });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    http
      .get({ port, agent: false }, (r) => {
        r.resume();
        r.on('end', resolve);
      })
      .on('error', reject);
  });
  // `process.emitWarning` delivers on a later tick.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  server.close();
  process.off('warning', onWarning);
  return { warnings };
}

describe('installResponseCloseListenerLimit', () => {
  afterEach(() => uninstallResponseCloseListenerLimit());

  it('control: without the install, 11 close listeners warn (the production symptom)', async () => {
    const { warnings } = await addListeners(11);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/11 close listeners added to \[ServerResponse\]/);
  });

  it('with the install, 11 close listeners on a response raise no warning', async () => {
    installResponseCloseListenerLimit();
    const { warnings } = await addListeners(11);
    expect(warnings).toEqual([]);
  });

  it('still warns on a genuine pile-up past the ceiling', async () => {
    installResponseCloseListenerLimit();
    const { warnings } = await addListeners(RESPONSE_CLOSE_LISTENER_LIMIT + 1);
    expect(warnings).toHaveLength(1);
  });

  it('raises the limit on the response only, never the process-wide default', async () => {
    installResponseCloseListenerLimit();
    await addListeners(1);
    expect(EventEmitter.defaultMaxListeners).toBe(10);
    expect(new EventEmitter().getMaxListeners()).toBe(10);
  });

  it('is idempotent: a second install does not stack subscriptions', async () => {
    installResponseCloseListenerLimit();
    installResponseCloseListenerLimit();
    const { warnings } = await addListeners(11);
    expect(warnings).toEqual([]);
  });
});
