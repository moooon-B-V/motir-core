// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { renderMarkdown } from '@/lib/markdown/render';

// Smoke test for the Markdown render stack (lib/markdown/render.tsx) — the
// pipeline behind work-item descriptionMd / explanationMd. Runs in happy-dom
// (opted in via the directive above; the rest of the suite stays on node).
//
// One fixture exercises every GFM feature the Story commits to, plus an
// inline <script> that MUST be stripped (the XSS guarantee). Assertions:
//   - the <script> tag never reaches the DOM
//   - headings / lists / ordered lists / task checkbox / table / link / image
//     render as the expected semantic HTML
//   - the fenced `tsx` code block carries rehype-highlight's hljs-* markup

const FIXTURE = `# Heading One

## Heading Two

Some **bold** and *italic* text.

- bullet alpha
- bullet beta

1. ordered first
2. ordered second

- [ ] unchecked task
- [x] checked task

| Feature | Status |
| ------- | ------ |
| tables  | yes    |

\`\`\`tsx
const greeting: string = 'hello';
console.log(greeting);
\`\`\`

[example link](https://example.com)

![the alt text](https://example.com/image.png)

<script>alert(1)</script>
`;

describe('renderMarkdown', () => {
  const { container } = render(renderMarkdown(FIXTURE));
  const html = container.innerHTML;

  it('strips inline <script> tags (XSS guard)', () => {
    expect(container.querySelector('script')).toBeNull();
    expect(html).not.toContain('<script');
    // The text node "alert(1)" may remain as inert text, but no executable
    // element wraps it.
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders headings as <h1>/<h2>', () => {
    expect(container.querySelector('h1')?.textContent).toBe('Heading One');
    expect(container.querySelector('h2')?.textContent).toBe('Heading Two');
  });

  it('renders bold and italic emphasis', () => {
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
  });

  it('renders an unordered list', () => {
    const ul = container.querySelector('ul');
    expect(ul).not.toBeNull();
    const items = Array.from(ul!.querySelectorAll('li')).map((li) => li.textContent?.trim());
    expect(items).toContain('bullet alpha');
    expect(items).toContain('bullet beta');
  });

  it('renders an ordered list', () => {
    const ol = container.querySelector('ol');
    expect(ol).not.toBeNull();
    expect(ol!.querySelectorAll('li').length).toBe(2);
  });

  it('renders GFM task-list checkboxes', () => {
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    const checked = container.querySelectorAll('input[type="checkbox"]:checked');
    expect(checked.length).toBe(1);
  });

  it('renders a GFM table with header and body cells', () => {
    expect(container.querySelector('table')).not.toBeNull();
    const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent);
    expect(headers).toEqual(['Feature', 'Status']);
    const cells = Array.from(container.querySelectorAll('td')).map((td) => td.textContent);
    expect(cells).toEqual(['tables', 'yes']);
  });

  it('renders a link with its href', () => {
    const a = container.querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com');
    expect(a?.textContent).toBe('example link');
  });

  it('renders an image with src and alt', () => {
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/image.png');
    expect(img?.getAttribute('alt')).toBe('the alt text');
  });

  it('syntax-highlights the fenced tsx code block (hljs-* markup)', () => {
    const code = container.querySelector('pre code');
    expect(code).not.toBeNull();
    // rehype-highlight adds the `hljs` class on the <code> and hljs-* spans
    // inside it. The order (sanitize THEN highlight) keeps these classes alive.
    expect(code!.className).toContain('hljs');
    expect(html).toContain('hljs-');
  });
});

// ── Mention rendering (Subtask 5.1.4) ───────────────────────────────────────
// `[@Display Name](mention:<userId>)` renders as the designed user chip — a
// non-navigable <span class="mention-chip"> (comments.mock.html panel 5) — via
// a `mention` entry added to the sanitize schema's href protocols FOR a.href
// ONLY. The XSS posture is otherwise unchanged, asserted below.
describe('renderMarkdown — mention tokens', () => {
  it('renders a well-formed mention token as the chip, never an anchor', () => {
    const { container } = render(
      renderMarkdown(`Handing the drag fix to [@Bo Philips](mention:cm9zabc123) — repro above.`),
    );
    const chip = container.querySelector('span.mention-chip');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toBe('@Bo Philips');
    // No navigable anchor wraps it (and no anchor carries the mention href).
    expect(container.querySelector('a[href^="mention:"]')).toBeNull();
  });

  it('a malformed/stale token (empty id) degrades to plain text — never a broken link', () => {
    const { container } = render(renderMarkdown(`ghost [@Ghost](mention:) here`));
    expect(container.querySelector('.mention-chip')).toBeNull();
    expect(container.querySelector('a[href^="mention:"]')).toBeNull();
    expect(container.textContent).toContain('@Ghost');
  });

  it('javascript: links stay dead (no XSS regression from the schema extension)', () => {
    const { container } = render(
      renderMarkdown(`[click](javascript:alert(1)) and <script>alert(2)</script>`),
    );
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('other unknown protocols are still stripped (mention is the only addition)', () => {
    const { container } = render(renderMarkdown(`[x](vbscript:foo) [y](weird:thing)`));
    expect(container.querySelector('a[href^="vbscript"]')).toBeNull();
    expect(container.querySelector('a[href^="weird"]')).toBeNull();
  });

  it('normal links still render as underlined anchors', () => {
    const { container } = render(renderMarkdown(`[docs](https://example.com)`));
    const a = container.querySelector('a[href="https://example.com"]') as HTMLAnchorElement;
    expect(a).toBeTruthy();
    expect(a.style.textDecorationLine).toBe('underline');
  });
});
