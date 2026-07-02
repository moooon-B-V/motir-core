import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { TokensSpecimen, Button, Card, Pill } from '../src/index';

// Prove the extracted primitives + provider + specimen actually MOUNT (exports
// resolve AND render), without a jsdom/testing-library dependency: render to
// static markup via react-dom/server. The `'use client'` directive is a no-op
// outside Next, so these are plain React components here.
describe('primitives + specimen render', () => {
  it('individual primitives render to markup', () => {
    expect(renderToStaticMarkup(createElement(Button, null, 'Go'))).toContain('Go');
    expect(renderToStaticMarkup(createElement(Card, null, 'Body'))).toContain('Body');
    expect(renderToStaticMarkup(createElement(Pill, { status: 'in-progress' }, 'Doing'))).toContain(
      'Doing',
    );
  });

  it('the TokensSpecimen mounts (ThemeProvider + scoped StyleVignettes + primitives)', () => {
    const html = renderToStaticMarkup(createElement(TokensSpecimen));
    // Header + a primitive prove the tree rendered end-to-end.
    expect(html).toContain('@motir/design-system');
    expect(html).toContain('Primary');
    // A scoped StyleVignette emits its axis attribute + accessible label, proving
    // the registries + preview specimen compose and the swap layer is wired.
    expect(html).toContain('data-style=');
    expect(html).toContain('aria-label="Style:');
    expect(html).toContain('aria-label="Palette:');
  });
});
