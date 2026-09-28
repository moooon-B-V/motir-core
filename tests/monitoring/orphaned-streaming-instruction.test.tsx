// @vitest-environment happy-dom
import { Suspense, use } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import type { ErrorEvent } from '@sentry/nextjs';
import { describe, expect, it } from 'vitest';
import {
  dropOrphanedStreamingInstructions,
  isOrphanedStreamingInstruction,
} from '@/lib/monitoring/orphanedStreamingInstruction';

// MOTIR-6773: production reported `TypeError: Cannot read properties of null
// (reading 'parentNode')` in `$RS`, from the document `/items/MOTIR-6744` itself.
// `$RS` is React's streaming instruction, not our code. These tests take the
// REAL instruction from React's streaming server, show it throws exactly that
// once its placeholder has gone (and not while it is there), and pin the filter
// that keeps its echo out of Sentry while every fault of ours still goes through.

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Streams a Suspense boundary whose content arrives in TWO parts — the shape
 * the item page's late sections take — and returns the whole document text.
 * The outer part is flushed while the boundary is still pending (a hidden
 * `S:0` holding the placeholder `P:1`), and the inner part lands later, moved
 * into place by `$RS("S:1","P:1")`.
 */
async function streamTwoPartBoundary(): Promise<string> {
  const outer = deferred<string>();
  const inner = deferred<string>();
  function Inner() {
    return <p id="inner">{use(inner.promise)}</p>;
  }
  function Outer() {
    return (
      <section id="outer">
        {use(outer.promise)}
        <Inner />
      </section>
    );
  }
  const stream = await renderToReadableStream(
    <html>
      <body>
        <Suspense fallback={<p>loading</p>}>
          <Outer />
        </Suspense>
      </body>
    </html>,
  );
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = '';
  const drain = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      html += decoder.decode(value, { stream: true });
    }
  })();
  // Let the shell flush, then the outer part, then the inner part.
  await new Promise((r) => setTimeout(r, 10));
  outer.resolve('outer');
  await new Promise((r) => setTimeout(r, 10));
  inner.resolve('inner');
  await drain;
  return html;
}

/** The inline script that carries `$RS(...)`, exactly as React wrote it. */
function completeSegmentScript(html: string): string {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  const script = scripts.find((s) => s.includes('$RS('));
  if (!script) throw new Error(`React emitted no $RS instruction:\n${html}`);
  return script;
}

/** Runs a document's inline script the way the browser does — as global code. */
function runInline(script: string): void {
  new Function(script)();
}

/** The event production recorded (motir.sentry.io issue 7759059361), frames oldest-first. */
function productionEvent(overrides: { function?: string; filename?: string } = {}): ErrorEvent {
  const filename = overrides.filename ?? 'app:///items/MOTIR-6744';
  return {
    type: undefined,
    exception: {
      values: [
        {
          type: 'TypeError',
          value: "Cannot read properties of null (reading 'parentNode')",
          mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false },
          stacktrace: {
            frames: [
              { filename, function: '?', lineno: 312, in_app: true },
              { filename, function: overrides.function ?? '$RS', lineno: 312, in_app: true },
            ],
          },
        },
      ],
    },
  };
}

describe("React's $RS instruction, run against the DOM it was streamed for", () => {
  it('moves the late segment into its placeholder when the placeholder is still there (control)', async () => {
    const script = completeSegmentScript(await streamTwoPartBoundary());
    document.body.innerHTML =
      '<div hidden id="S:0"><section id="outer">outer<template id="P:1"></template></section></div>' +
      '<div hidden id="S:1"><p id="inner">inner</p></div>';

    expect(() => runInline(script)).not.toThrow();
    expect(document.querySelector('#outer #inner')?.textContent).toBe('inner');
    expect(document.getElementById('P:1')).toBeNull();
  });

  it('throws the TypeError production reported once a client re-render has removed the placeholder', async () => {
    const script = completeSegmentScript(await streamTwoPartBoundary());
    // What a root-level hydration failure leaves: React client-rendered the root
    // and cleared <body>, taking `S:0` (and `P:1` inside it) away; the parser
    // then appended the late segment `S:1` and its script to the cleared body.
    document.body.innerHTML = '<div hidden id="S:1"><p id="inner">inner</p></div>';

    expect(() => runInline(script)).toThrow(
      new TypeError("Cannot read properties of null (reading 'parentNode')"),
    );
  });
});

describe('dropOrphanedStreamingInstructions', () => {
  it('drops the event production recorded — $RS, running from the page document', () => {
    const event = productionEvent();
    expect(isOrphanedStreamingInstruction(event)).toBe(true);
    expect(dropOrphanedStreamingInstructions(event)).toBeNull();
  });

  it.each(['$RC', '$RX', '$RV', '$RB'])(
    'drops React’s other streaming instruction %s too',
    (fn) => {
      expect(dropOrphanedStreamingInstructions(productionEvent({ function: fn }))).toBeNull();
    },
  );

  it('drops it from a document address that carries a query or a fragment', () => {
    const event = productionEvent({
      filename: 'https://app.motir.co/items/MOTIR-6744?activity=history#comments',
    });
    expect(dropOrphanedStreamingInstructions(event)).toBeNull();
  });

  it('KEEPS the same TypeError thrown from our own bundled code', () => {
    const event = productionEvent({
      function: 'ItemView',
      filename: 'app:///_next/static/chunks/app/(authed)/items/[key]/page-3f2a.js',
    });
    expect(dropOrphanedStreamingInstructions(event)).toBe(event);
  });

  it('KEEPS a $R-named function that lives in a script file — that is somebody else’s code', () => {
    const event = productionEvent({ filename: 'app:///_next/static/chunks/vendor.mjs?v=2' });
    expect(dropOrphanedStreamingInstructions(event)).toBe(event);
  });

  it('KEEPS the hydration failure itself — the fault the echo points back at', () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Minified React error #418; visit https://react.dev/errors/418',
            stacktrace: {
              frames: [
                {
                  filename: 'app:///_next/static/chunks/react-dom.js',
                  function: 'reportError',
                  lineno: 1,
                },
              ],
            },
          },
        ],
      },
    };
    expect(dropOrphanedStreamingInstructions(event)).toBe(event);
  });

  it('KEEPS an event with no stack, or whose innermost frame names no function or file', () => {
    const bare: ErrorEvent = { type: undefined, message: 'something happened' };
    expect(dropOrphanedStreamingInstructions(bare)).toBe(bare);

    const anonymous = productionEvent();
    anonymous.exception!.values![0]!.stacktrace!.frames!.push({ lineno: 1 });
    expect(dropOrphanedStreamingInstructions(anonymous)).toBe(anonymous);
  });
});
