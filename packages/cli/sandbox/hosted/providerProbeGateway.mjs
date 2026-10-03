// The OFFLINE PROVIDER PROBE's stub gateway (Story MOTIR-7205 · MOTIR-7208).
//
// Plain ESM with no dependencies, so it runs unchanged both in-process (the
// probe test imports `startProbeGateway`) and as its own container on the
// probe's `--internal` network, booted from the hosted image's own Node
// (`node providerProbeGateway.mjs <port>`), where every request is printed as one
// `PROBE_REQUEST <json>` line on stdout.
//
// It answers exactly the two routes the egress contract (motir-gateway
// `docs/hosted-run-egress.md` §2–§3) says a hosted OpenCode calls:
//   - `POST /v1/messages`          — an Anthropic model, Messages SSE;
//   - `POST /v1/chat/completions`  — a DeepSeek, GLM, Qwen or Kimi model, OpenAI-shaped SSE.
// Anything else is recorded and answered 404, so a request the contract does not
// name shows up in the record AND fails the run.

import { createServer } from 'node:http';

const ANSWER = 'probe ok';

function anthropicStream(res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_probe',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ];
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function chatStream(res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = {
    id: 'chatcmpl-probe',
    object: 'chat.completion.chunk',
    created: 1759300000,
    model,
  };
  const chunks = [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: ANSWER }, finish_reason: null }],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    {
      ...base,
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 10,
      },
    },
  ];
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function chatJson(res, model) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'chatcmpl-probe',
      object: 'chat.completion',
      created: 1759300000,
      model,
      choices: [
        { index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
  );
}

/**
 * Starts the stub on `port` (0 = any) and calls `onRequest` with each recorded
 * request: `{ method, path, apiKey, authorization, model }`.
 */
export function startProbeGateway(port, onRequest) {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const path = (req.url ?? '').split('?')[0];
      onRequest({
        method: req.method,
        path,
        apiKey: req.headers['x-api-key'] ?? null,
        authorization: req.headers['authorization'] ?? null,
        model: typeof body.model === 'string' ? body.model : null,
      });
      const model = typeof body.model === 'string' ? body.model : 'unknown';
      if (req.method === 'POST' && path === '/v1/messages') return anthropicStream(res, model);
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        return body.stream === false ? chatJson(res, model) : chatStream(res, model);
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `the probe gateway does not serve ${path}` } }));
    });
  });
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(server)));
}

// As a container: `node providerProbeGateway.mjs <port>`.
if (process.argv[1] && process.argv[1].endsWith('providerProbeGateway.mjs')) {
  const port = Number(process.argv[2] ?? 8080);
  await startProbeGateway(port, (r) =>
    process.stdout.write(`PROBE_REQUEST ${JSON.stringify(r)}\n`),
  );
  process.stdout.write(`PROBE_READY ${port}\n`);
}
