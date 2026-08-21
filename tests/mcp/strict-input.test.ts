import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import {
  nearestField,
  strictInputSchema,
  strictInputServer,
  strictifyUnknownKeys,
  unknownKeyMessage,
} from '@/lib/mcp/strictInput';
import { runUpdateWorkItem } from '@/lib/mcp/tools/updateWorkItem';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The UNKNOWN-ARGUMENT gate (bug MOTIR-3342). Three layers, mirroring the rest
// of the MCP suite:
//
//  - the PURE transform (`strictifyUnknownKeys` / `strictInputSchema` and the
//    suggestion helpers) — every wrapper kind and both sides of the
//    strip-vs-chosen decision, so a `.passthrough()` someone chose on purpose is
//    provably left alone;
//  - the WIRED registry looped over EVERY tool — the "fails by construction"
//    guard. The class this bug is about is per-TOOL, not per-field: a fix that
//    special-cased `description` would leave `linkType` and every future rename
//    open, so the assertion is over `MCP_TOOL_NAMES` and a future tool that
//    somehow escapes the seam surfaces here;
//  - the ORIGINAL FIXTURES, verbatim from the card — `description` instead of
//    `descriptionMd` on both write tools, `linkType` instead of `relationship`,
//    and the `Patched: nothing` success that hid all of it.
//
// ⚠️ The reproduction, before the fix, was: `tools/list` published
// `"additionalProperties": false` while `tools/call` accepted the unknown key,
// dropped it, and returned a SUCCESS. So the published-schema assertion below is
// half the deliverable — it is what makes the runtime and the advertised
// contract agree, and it must keep saying `false`.

/** A context resolver that FAILS if a tool body is ever reached. The gate runs
 * at input validation, before the callback, so a rejected call must never get
 * this far — and if one does, the test says so rather than hanging on a DB. */
const neverResolved = (() => {
  throw new Error('tool body reached — input validation should have rejected the call');
}) as unknown as () => ServiceContext;

/** The tool call's outcome as an agent sees it. The SDK converts the
 * `McpError(InvalidParams)` its validator throws into an `isError` tool result
 * carrying that message (`McpServer`'s CallTool handler catches and calls
 * `createToolError`), so the refusal is read here, not in a rejected promise. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { isError: result.isError === true, text: JSON.stringify(result.content) };
}

/** Connect an in-memory client to the fully-registered server. */
async function connectRegistry(): Promise<Client> {
  const server = buildMcpServer(neverResolved);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('nearestField — the suggestion a caller actually reads', () => {
  it('prefers a PREFIX relationship, which is the shape of this bug', () => {
    expect(nearestField('description', ['key', 'descriptionMd', 'explanationMd'])).toBe(
      'descriptionMd',
    );
    expect(nearestField('explanation', ['key', 'descriptionMd', 'explanationMd'])).toBe(
      'explanationMd',
    );
  });

  it('accepts a small edit distance, scaled to the word length', () => {
    expect(nearestField('estimateMinute', ['estimateMinutes', 'storyPoints'])).toBe(
      'estimateMinutes',
    );
    expect(nearestField('storypoints', ['estimateMinutes', 'storyPoints'])).toBe('storyPoints');
  });

  it('returns null rather than inventing a neighbour', () => {
    // The card's OTHER fixture: `linkType` has no near neighbour among
    // link_work_items' fields, and naming one would be worse than naming none.
    expect(nearestField('linkType', ['fromKey', 'toKey', 'relationship'])).toBeNull();
    expect(nearestField('zzz', [])).toBeNull();
  });

  it('picks the CLOSEST of several plausible neighbours', () => {
    expect(nearestField('targetRepoz', ['targetRepo', 'targetRepos', 'targetRepositories'])).toBe(
      'targetRepo',
    );
  });
});

describe('unknownKeyMessage — names the key, the guess, and the accepted set', () => {
  it('names one unknown argument with its nearest field', () => {
    const message = unknownKeyMessage(['description'], ['key', 'descriptionMd']);
    expect(message).toContain('Unknown argument "description" (did you mean "descriptionMd"?)');
    expect(message).toContain('This tool accepts only: key, descriptionMd');
  });

  it('pluralises, and omits a guess it does not have', () => {
    const message = unknownKeyMessage(['linkType', 'nonsense'], ['fromKey', 'relationship']);
    expect(message).toContain('Unknown arguments "linkType", "nonsense"');
    expect(message).not.toContain('did you mean');
  });
});

describe('strictifyUnknownKeys — the transform, wrapper by wrapper', () => {
  it('promotes a default (strip) object to strict', () => {
    const strict = strictifyUnknownKeys(z.object({ a: z.string() }));
    expect(strict.safeParse({ a: 'x' }).success).toBe(true);
    const bad = strict.safeParse({ a: 'x', b: 'y' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.code).toBe('unrecognized_keys');
    expect(bad.error?.issues[0]?.message).toContain('Unknown argument "b"');
  });

  it('LEAVES a deliberate .passthrough() alone — that one was chosen', () => {
    // `authorPlan`'s patchSchema is `.passthrough()` precisely so this schema can
    // never become the reason a field the service understands stops arriving
    // (MOTIR-3111). Strictifying it would be a regression, not a fix.
    const kept = strictifyUnknownKeys(z.object({ a: z.string() }).passthrough());
    const parsed = kept.safeParse({ a: 'x', extra: 1 });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ a: 'x', extra: 1 });
  });

  it('LEAVES a .catchall() alone', () => {
    const kept = strictifyUnknownKeys(z.object({ a: z.string() }).catchall(z.number()));
    expect(kept.safeParse({ a: 'x', extra: 1 }).success).toBe(true);
    expect(kept.safeParse({ a: 'x', extra: 'no' }).success).toBe(false);
  });

  it('keeps an error map the schema already declared', () => {
    const declared = z.object(
      { a: z.string() },
      { errorMap: () => ({ message: 'the schema said so' }) },
    );
    const strict = strictifyUnknownKeys(declared);
    const bad = strict.safeParse({ a: 'x', b: 1 });
    expect(JSON.stringify(bad.error?.issues)).toContain('the schema said so');
  });

  it('leaves NON-unrecognised issues to the default message', () => {
    const strict = strictifyUnknownKeys(z.object({ a: z.string() }));
    const bad = strict.safeParse({});
    expect(JSON.stringify(bad.error?.issues)).toContain('Required');
  });

  it('descends through array / optional / nullable / default / union wrappers', () => {
    const inner = z.object({ a: z.string() });
    const nested = z.object({
      list: z.array(inner),
      maybe: inner.optional(),
      nullable: inner.nullable(),
      defaulted: inner.default({ a: 'seed' }),
      either: z.union([z.string(), inner]),
    });
    const strict = strictifyUnknownKeys(nested);
    const base = { list: [{ a: 'x' }], nullable: null, either: 'plain' };
    expect(strict.safeParse(base).success).toBe(true);
    expect(strict.safeParse({ ...base, list: [{ a: 'x', b: 1 }] }).success).toBe(false);
    expect(strict.safeParse({ ...base, maybe: { a: 'x', b: 1 } }).success).toBe(false);
    expect(strict.safeParse({ ...base, nullable: { a: 'x', b: 1 } }).success).toBe(false);
    expect(strict.safeParse({ ...base, defaulted: { a: 'x', b: 1 } }).success).toBe(false);
    expect(strict.safeParse({ ...base, either: { a: 'x', b: 1 } }).success).toBe(false);
    // The DEFAULT still applies — rebuilding the wrapper must not lose it.
    expect(strict.parse(base)).toMatchObject({ defaulted: { a: 'seed' } });
  });

  it('preserves a description, so tools/list copy survives the rewrite', () => {
    const described = z.object({ a: z.string() }).describe('the shape');
    expect(strictifyUnknownKeys(described).description).toBe('the shape');
  });

  it('returns anything it does not recognise untouched', () => {
    const leaf = z.string();
    expect(strictifyUnknownKeys(leaf)).toBe(leaf);
  });
});

describe('strictInputSchema — raw shapes, schemas, and everything else', () => {
  it('wraps a raw shape into a strict object', () => {
    const wrapped = strictInputSchema({ key: z.string() }) as z.ZodTypeAny;
    expect(wrapped.safeParse({ key: 'ACME-7' }).success).toBe(true);
    expect(wrapped.safeParse({ key: 'ACME-7', nope: 1 }).success).toBe(false);
  });

  it('wraps an EMPTY raw shape too — a no-argument tool still refuses one', () => {
    const wrapped = strictInputSchema({}) as z.ZodTypeAny;
    expect(wrapped.safeParse({}).success).toBe(true);
    expect(wrapped.safeParse({ nope: 1 }).success).toBe(false);
  });

  it('strictifies an already-constructed schema', () => {
    const wrapped = strictInputSchema(z.object({ key: z.string() })) as z.ZodTypeAny;
    expect(wrapped.safeParse({ key: 'x', nope: 1 }).success).toBe(false);
  });

  it('returns a value that is neither a raw shape nor a schema untouched', () => {
    expect(strictInputSchema(undefined)).toBeUndefined();
    expect(strictInputSchema('not a schema')).toBe('not a schema');
    expect(strictInputSchema(null)).toBeNull();
    const notAShape = { a: 'string, not a zod schema' };
    expect(strictInputSchema(notAShape)).toBe(notAShape);
  });
});

describe('strictInputServer — the registration seam', () => {
  function probeServer(): { calls: unknown[][]; proxied: McpServer } {
    const calls: unknown[][] = [];
    const fake = {
      registerTool: (...args: unknown[]) => {
        calls.push(args);
        return 'registered';
      },
      somethingElse: 'passed through',
    } as unknown as McpServer;
    return { calls, proxied: strictInputServer(fake) };
  }

  it('rewrites the config s inputSchema and leaves the name + callback alone', () => {
    const { calls, proxied } = probeServer();
    const callback = vi.fn();
    proxied.registerTool(
      'probe',
      { title: 'Probe', description: 'd', inputSchema: { key: z.string() } },
      callback as never,
    );
    const [name, config, passed] = calls[0] as [string, { inputSchema: z.ZodTypeAny }, unknown];
    expect(name).toBe('probe');
    expect(passed).toBe(callback);
    expect(config.inputSchema.safeParse({ key: 'x', nope: 1 }).success).toBe(false);
  });

  it('passes a config with NO inputSchema straight through', () => {
    const { calls, proxied } = probeServer();
    const config = { title: 'Probe', description: 'd' };
    (proxied.registerTool as unknown as (...a: unknown[]) => unknown)('probe', config, vi.fn());
    expect(calls[0]?.[1]).toBe(config);
  });

  it('passes every other member through untouched', () => {
    const { proxied } = probeServer();
    expect((proxied as unknown as { somethingElse: string }).somethingElse).toBe('passed through');
  });
});

describe('the WIRED registry — every tool refuses an unknown argument', () => {
  it('publishes additionalProperties:false AND honours it, for every tool', async () => {
    const client = await connectRegistry();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());

    for (const tool of tools) {
      // Half the bug was that this promise was published and not kept.
      expect(tool.inputSchema.additionalProperties, `${tool.name} must publish it`).toBe(false);

      const refused = await call(client, tool.name, { motirUnknownProbe: 'lost text' });
      expect(refused.isError, `${tool.name} must refuse an unknown argument`).toBe(true);
      expect(refused.text, `${tool.name} must NAME the unknown argument`).toContain(
        'motirUnknownProbe',
      );
    }
  }, 30_000);
});

describe('the card s own fixtures', () => {
  it('create_work_item refuses `description` and suggests `descriptionMd`', async () => {
    const client = await connectRegistry();
    const refused = await call(client, 'create_work_item', {
      projectKey: 'TEST',
      kind: 'task',
      title: 'probe',
      description: 'this text will vanish',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('description');
    expect(refused.text).toContain('did you mean');
    expect(refused.text).toContain('descriptionMd');
  });

  it('update_work_item refuses `description` and suggests `descriptionMd`', async () => {
    const client = await connectRegistry();
    const refused = await call(client, 'update_work_item', {
      key: 'MOTIR-3334',
      description: 'probe',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('did you mean');
    expect(refused.text).toContain('descriptionMd');
    expect(refused.text).not.toContain('Patched');
  });

  it('link_work_items names `linkType` — the missing-required error used to hide it', async () => {
    const client = await connectRegistry();
    const refused = await call(client, 'link_work_items', {
      fromKey: 'MOTIR-1',
      toKey: 'MOTIR-2',
      linkType: 'relates_to',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('linkType');
  });

  it('add_plan_items refuses a typo NESTED in proposedFields', async () => {
    const client = await connectRegistry();
    const refused = await call(client, 'add_plan_items', {
      planId: 'plan-1',
      proposals: [
        { op: 'add', proposedFields: { title: 'probe', description: 'this would vanish' } },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('did you mean');
    expect(refused.text).toContain('descriptionMd');
  });

  it('add_plan_items KEEPS a passthrough patch key — MOTIR-3111 is not undone', async () => {
    // A `modify` patch is `.passthrough()` on purpose. It must still reach the
    // service, so this call gets PAST validation and into the tool body — which
    // the throwing resolver proves by being reached at all.
    const client = await connectRegistry();
    const reached = await call(client, 'add_plan_items', {
      planId: 'plan-1',
      proposals: [
        { op: 'modify', workItemId: 'cmq1', patch: { title: 'x', aFieldWeDoNotKnow: 1 } },
      ],
    });
    expect(reached.text).toContain('tool body reached');
    expect(reached.text).not.toContain('aFieldWeDoNotKnow');
  });
});

describe('a patch that changes NOTHING is not a success (the second half)', () => {
  it('update_work_item with only `key` is refused, before any service call', async () => {
    const asResult = await runUpdateWorkItem({ key: 'MOTIR-3334' }, {} as ServiceContext);
    expect(asResult.isError).toBe(true);
    expect(JSON.stringify(asResult.content)).toContain('NO_FIELDS_TO_PATCH');
    expect(JSON.stringify(asResult.content)).not.toContain('Patched: nothing');
  });
});
