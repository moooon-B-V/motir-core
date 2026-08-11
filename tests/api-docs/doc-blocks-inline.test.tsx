// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { DocBlock, DocInline } from '@/app/(public)/docs/_components/DocBlocks';
import type { GuideBlock } from '@/lib/apiDocs/guide';
import * as guide from '@/lib/apiDocs/guide';
import * as sandbox from '@/lib/apiDocs/sandbox';
import * as cli from '@/lib/apiDocs/cli';
import * as mcp from '@/lib/apiDocs/mcp';

// The two inline marks, NESTED (MOTIR-2616).
//
// `renderInline` split its input one level deep and emitted a bold run's
// contents as a raw string, so every `**bold `filename`**` in the document set
// printed its backticks on the shipped page. The fix is a recursive bold arm and
// a literal code arm — an ASYMMETRY, because code means "these exact
// characters". Both directions are asserted here, so the fix cannot degenerate
// into stripping every mark everywhere.
//
// The corpus sweep at the bottom is the drift guard: it re-derives the affected
// sites from the shipped content instead of pinning the five that existed on
// 2026-08-10.

afterEach(cleanup);

/** Render one authored string the way a `prose` block does. */
function prose(text: string): HTMLElement {
  const { container } = render(<DocBlock block={{ kind: 'prose', text }} />);
  return container;
}

/** The rendered text with every `<code>` span's own contents removed. */
function textOutsideCode(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const code of [...clone.querySelectorAll('code')]) code.remove();
  return clone.textContent ?? '';
}

describe('renderInline — bold and code nest', () => {
  it('renders a code span inside a bold run as a <code> inside the <strong>', () => {
    const container = prose('**2 · Add `.devcontainer/devcontainer.json`** to the folder.');

    const strong = container.querySelector('strong');
    expect(strong).toBeTruthy();
    const code = strong?.querySelector('code');
    expect(code?.textContent).toBe('.devcontainer/devcontainer.json');

    // What the reader actually sees: no punctuation left over from either mark.
    expect(container.textContent).toBe('2 · Add .devcontainer/devcontainer.json to the folder.');
    expect(container.textContent).not.toContain('`');
    expect(container.textContent).not.toContain('**');
  });

  it('nests either way round and more than once in a run', () => {
    const container = prose('**a `one` b `two` c** tail');

    const strong = container.querySelector('strong');
    expect([...(strong?.querySelectorAll('code') ?? [])].map((c) => c.textContent)).toEqual([
      'one',
      'two',
    ]);
    expect(container.textContent).toBe('a one b two c tail');
  });

  it('keeps a code span LITERAL — asterisks inside it survive', () => {
    const container = prose('Match everything with `**/*.ts` in the glob.');

    const code = container.querySelector('code');
    expect(code?.textContent).toBe('**/*.ts');
    // No <strong> was invented from the code span's own asterisks…
    expect(container.querySelector('strong')).toBeNull();
    // …and the reader still sees them.
    expect(container.textContent).toBe('Match everything with **/*.ts in the glob.');
  });

  it('lets a code span that OPENS FIRST win over a later bold delimiter', () => {
    const container = prose('`a ** b` and then **bold** after.');

    expect(container.querySelector('code')?.textContent).toBe('a ** b');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.textContent).toBe('a ** b and then bold after.');
  });

  it('bolds a run that CONTAINS an asterisk — the old `[^*]+` refused to', () => {
    const container = prose('**Pass `*.ts` to the matcher** and nothing else.');

    const strong = container.querySelector('strong');
    expect(strong?.querySelector('code')?.textContent).toBe('*.ts');
    expect(container.textContent).toBe('Pass *.ts to the matcher and nothing else.');
  });

  it('leaves an UNPAIRED mark as the characters the author typed', () => {
    // A lone `**` or backtick passes a startsWith/endsWith pair on its own; the
    // length guards are what stop it rendering as an empty element.
    expect(prose('two stars ** alone').textContent).toBe('two stars ** alone');
    expect(prose('one backtick ` alone').textContent).toBe('one backtick ` alone');
  });

  it('applies the same treatment to callout and table blocks', () => {
    const callout = render(
      <DocBlock
        block={{ kind: 'callout', tone: 'warning', text: 'Note there is **no `--rm`**.' }}
      />,
    ).container;
    expect(callout.querySelector('strong')?.querySelector('code')?.textContent).toBe('--rm');
    expect(callout.textContent).not.toContain('`');

    const table = render(
      <DocBlock
        block={{
          kind: 'table',
          columns: ['**a `col`**'],
          rows: [['**a `cell`**']],
        }}
      />,
    ).container;
    for (const cell of [...table.querySelectorAll('th, td, dd')]) {
      expect(cell.textContent).not.toContain('`');
    }
  });

  it('DocInline inherits the fix rather than carrying a second copy', () => {
    // The exported sibling `renderInline` backs, for callers that lay out their
    // own paragraph (the MCP page's per-client footnotes).
    const { container } = render(<DocInline text="Give it **a `--flag`**, not the token." />);

    expect(container.querySelector('strong')?.querySelector('code')?.textContent).toBe('--flag');
    expect(container.textContent).toBe('Give it a --flag, not the token.');
  });
});

/**
 * Every inline string the docs surface actually ships, swept for leaked marks.
 *
 * The card that filed this bug listed five sites and said the list would drift —
 * it already had by the time the fix was written. So the guard re-derives them:
 * it walks the shipped block collections for anything `DocBlock` hands to
 * `renderInline`, and asserts no mark survives into the rendered text. A sixth
 * site added next month is covered the day it lands.
 */
function collectInlineStrings(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectInlineStrings(entry, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;

  const block = value as Partial<GuideBlock> & Record<string, unknown>;
  if (block.kind === 'prose' || block.kind === 'callout') {
    if (typeof block.text === 'string') found.push(block.text);
    return found;
  }
  if (block.kind === 'table') {
    for (const column of (block.columns as readonly string[] | undefined) ?? []) found.push(column);
    for (const row of (block.rows as readonly (readonly string[])[] | undefined) ?? []) {
      for (const cell of row) found.push(cell);
    }
    return found;
  }
  for (const entry of Object.values(block)) collectInlineStrings(entry, found);
  return found;
}

describe('the shipped docs corpus renders no leaked marks', () => {
  const strings = [
    ...collectInlineStrings([
      guide.GUIDE_STEPS,
      guide.POLICY_SECTIONS,
      sandbox.SANDBOX_INTRO,
      sandbox.SANDBOX_STEPS,
      sandbox.SANDBOX_WHAT_NEXT,
      cli.CLI_INTRO,
      cli.CLI_STEPS,
      cli.CLI_FILES,
      cli.CLI_WHAT_NEXT,
      mcp.MCP_FORK_STEER,
    ]),
    // `DocInline`'s own callers: the MCP page's per-client footnotes.
    ...mcp.mcpClients().map((client) => client.note),
  ];

  it('sweeps a corpus big enough to contain the reported sites', () => {
    expect(strings.length).toBeGreaterThan(50);
    // The construct this bug is about is still authored in the corpus — a sweep
    // over content that no longer contains it would pass vacuously.
    expect(strings.filter((text) => /\*\*[^*]*`[^`]*`[^*]*\*\*/.test(text)).length).toBeGreaterThan(
      0,
    );
  });

  it.each(strings.map((text, index) => [index, text] as const))(
    'string %i renders with no backtick and no ** outside a code span',
    (_index, text) => {
      const outside = textOutsideCode(prose(text));
      expect(outside).not.toContain('`');
      expect(outside).not.toContain('**');
    },
  );
});
