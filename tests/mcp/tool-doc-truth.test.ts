import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '@/lib/mcp/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { fingerprintToolText } from '@/lib/apiDocs/mcpFingerprint';
import { mcpToolFingerprint, mcpToolRows, type McpCatalogueToolName } from '@/lib/apiDocs/mcp';

// THE TOOL-DOC TRUTH GATE — the fingerprint half of Story MOTIR-2309's gate
// (Subtask MOTIR-2330), restored here by MOTIR-4165.
//
// ── Why it lives in `tests/mcp/` and not where it was written ───────────────
// It was `tests/api-docs/mcp-truth.test.ts`, in a directory whose every OTHER
// member walked one of the four `app/(public)/docs/**` pages. MOTIR-3951 deleted
// those pages and MOTIR-3932 deleted the directory with them — correctly for
// every file in it but this one, which reads a DATA module and a live
// `tools/list` handshake and never touched a page. A deletion by PATH cannot see
// that distinction, so the gate went with the pages and the first divergence
// landed the next day: MOTIR-4153 rewrote `add_plan_items`' description and its
// stored pin stayed behind, green.
//
// So the home is chosen for one property: this file imports NO route, NO page
// and nothing under `app/`. Moving a page can no longer take it along.
//
// ── What it proves, and what it cannot ─────────────────────────────────────
// `lib/apiDocs/mcp.ts` is half derived and half authored. The derived half —
// every tool NAME, its gating permission, the grouping — cannot drift: it IS
// `TOOL_PERMISSIONS`, held key-equal by typecheck and re-checked over the served
// document by `tests/api/docs/mcp-tools-route.test.ts`. This file stands over the
// AUTHORED half: each one-line summary carries a fingerprint of the shipped
// `title` + `description` it was written against, and this recomputes every one
// of them from a live handshake.
//
// It does not prove a summary is GOOD — no test can. It proves nobody reworded
// the tool underneath it. When it fails, the fix is to re-read the tool, rewrite
// the summary if it now says something different, and THEN move the fingerprint.
// Moving the fingerprint alone converts the one signal that a summary is owed a
// re-read into a green check.

/** `tools/list` runs no handler and needs no actor, so a stub context is honest. */
const STUB_CONTEXT = { userId: 'gate', workspaceId: 'gate' } as unknown as ServiceContext;

interface ListedTool {
  name: string;
  title?: string;
  description?: string;
}

async function listShippedTools(): Promise<ListedTool[]> {
  const server = buildMcpServer(() => STUB_CONTEXT);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-tool-doc-truth', version: '0.0.0' });
  await client.connect(clientTransport);
  const listed = await client.listTools();
  await client.close();
  return listed.tools as ListedTool[];
}

/**
 * THE PREDICATE, extracted so the counterfactual below can drive the SAME code
 * the real assertion runs. A guard proved only to pass is a comment: the pin
 * test and the fires test differ in their `stored` lookup and in nothing else.
 *
 * `stored` is the lookup under test — the shipped one for the real gate, a
 * perturbed one for the counterfactual.
 */
function driftedPins(
  shipped: readonly ListedTool[],
  stored: (name: McpCatalogueToolName) => string | undefined,
): string[] {
  return shipped
    .map((tool) => {
      const name = tool.name as McpCatalogueToolName;
      const expected = fingerprintToolText(tool.title ?? '', tool.description ?? '');
      const held = stored(name);
      return held === expected ? null : `${name}: stored ${held}, shipped ${expected}`;
    })
    .filter((line): line is string => line !== null);
}

describe('the authored tool summaries against the SHIPPED tools/list', () => {
  // TOTALITY first, because the pin test iterates the SHIPPED list: a catalogue
  // entry for a tool the server no longer exposes would never be recomputed, and
  // "every stored fingerprint was verified" would be false while green.
  it('carries exactly the tools the server exposes — none missing, none left over', async () => {
    const shipped = (await listShippedTools()).map((tool) => tool.name).sort();
    const published = mcpToolRows()
      .map((row) => row.name)
      .sort();

    expect(published).toEqual(shipped);
  });

  // ⚠️ THE PIN. When this fails it is not flaky and it is not a re-wrap —
  // whitespace is normalized before hashing. Some tool's title or description
  // moved, and the summary published for it was written against the older text.
  // Re-read the tool, rewrite the summary if it now says something different, and
  // update the fingerprint in `lib/apiDocs/mcp.ts`. Do not just update the
  // fingerprint.
  it('pins every authored summary to the tool text it was written against', async () => {
    const shipped = await listShippedTools();
    const drifted = driftedPins(shipped, (name) => mcpToolFingerprint(name));

    expect(
      drifted,
      `these tools' shipped text changed since their published summary was written:\n  ${drifted.join('\n  ')}`,
    ).toEqual([]);
  });

  // The gate is proved to FIRE, not merely to pass: perturb ONE stored pin and
  // the same predicate must name that tool and both values. Without this the
  // test above is green on a lookup that returns the shipped value by
  // construction, which is exactly how a restored guard becomes a tautology.
  //
  // ⚠️ It is asserted as a DELTA against the un-perturbed run, not as the whole
  // output. Comparing the whole output would couple this test to the pin test's
  // subject: a real divergence would fail BOTH, turning one signal into three and
  // burying the tool name that matters under the counterfactual's noise. Asked as
  // a delta, it answers only its own question — does perturbing one pin add
  // exactly one correctly-worded line — and stays green while the pin test is red.
  it('FIRES on a single perturbed pin, naming the tool and both values', async () => {
    const shipped = await listShippedTools();
    const victim = shipped[0]?.name as McpCatalogueToolName;
    expect(victim, 'the server exposed no tools at all').toBeDefined();

    const shippedPin = fingerprintToolText(shipped[0]?.title ?? '', shipped[0]?.description ?? '');
    const perturbed = 'ffffffffffff';
    expect(perturbed).not.toBe(shippedPin);

    const baseline = driftedPins(shipped, (name) => mcpToolFingerprint(name));
    const drifted = driftedPins(shipped, (name) =>
      name === victim ? perturbed : mcpToolFingerprint(name),
    );

    expect(drifted.filter((line) => !baseline.includes(line))).toEqual([
      `${victim}: stored ${perturbed}, shipped ${shippedPin}`,
    ]);
  });

  // …and fires on an ABSENT pin too, which is what a tool added to the registry
  // without a catalogue entry would look like if typecheck were ever loosened.
  it('FIRES on a missing pin', async () => {
    const shipped = await listShippedTools();
    const victim = shipped[0]?.name as McpCatalogueToolName;

    const baseline = driftedPins(shipped, (name) => mcpToolFingerprint(name));
    const drifted = driftedPins(shipped, (name) =>
      name === victim ? undefined : mcpToolFingerprint(name),
    );
    const added = drifted.filter((line) => !baseline.includes(line));

    expect(added).toHaveLength(1);
    expect(added[0]).toContain(`${victim}: stored undefined, shipped `);
  });

  it('ignores a pure re-wrap — Prettier reflowing a literal is not drift', () => {
    const a = fingerprintToolText('Read a work item', 'One   item\n  in full.');
    const b = fingerprintToolText('Read a work item', 'One item in full.');
    expect(a).toBe(b);
  });
});

describe('the gate cannot be carried off by a page move again (MOTIR-4165)', () => {
  it('imports no route, no page and nothing under `app/`', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL(import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

    expect(imports.filter((specifier) => specifier?.includes('@/app/'))).toEqual([]);
    expect(imports.filter((specifier) => specifier?.includes('apiDocs/guide'))).toEqual([]);
  });
});
