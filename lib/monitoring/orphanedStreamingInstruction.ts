import type { ErrorEvent } from '@sentry/nextjs';

// The signal filter for the BROWSER's React streaming echoes (MOTIR-6773).
//
// React's streaming server writes small inline scripts into the document it
// streams — `$RS` moves a late segment into its placeholder, `$RC` reveals a
// completed Suspense boundary, and so on. They are React's code, not ours, and
// they run from the DOCUMENT itself, which is why a monitor names the page URL
// as their file (`app:///items/MOTIR-6744`, line 312).
//
// ⚠️ ONE OF THEM THROWING IS AN ECHO, NEVER THE FAULT. `$RS` reads
// `document.getElementById(<placeholder>).parentNode` with no null check, and
// the placeholder can only be missing if the client has already thrown away the
// server DOM it lived in. Reproduced against React 19.2.4 in Chromium: a
// hydration failure OUTSIDE any Suspense boundary makes React client-render the
// whole root, which clears `<body>` — the hidden `S:` segment holding the
// placeholder with it — and the next streamed `$RS` then throws exactly
// `TypeError: Cannot read properties of null (reading 'parentNode')`. It does
// NOT throw on a clean hydrate, on a soft navigation mid-stream (the hidden
// segments sit outside the app's tree and survive it), or when hydration lands
// before the first late segment or after the stream ends.
//
// ⚠️ SO DROPPING IT LOSES NOTHING, AND KEEPING IT MISLEADS. The fault that
// caused it — the hydration failure — is reported on its own: Next hydrates with
// `onRecoverableError`, which calls `window.reportError`, which Sentry's global
// handler captures. What this event adds is a second issue whose stack points
// at a line nobody here can edit, and whose only "fix" a reader can reach for is
// a null guard at a site React owns. That is the card this filter exists
// because of.
//
// ⚠️ THE MATCH IS THE FRAME, NOT THE MESSAGE. The message is the browser's
// wording for any null dereference (and differs per engine), so a message match
// would also swallow OUR null dereferences. The discriminator is WHERE it threw:
// the innermost frame is one of React's `$R<letter>` instructions AND it runs
// from the document, not from a script file. A function of that name inside a
// bundled `.js` chunk is somebody else's code and is kept.

/** React's streaming instruction globals: `$RS`, `$RC`, `$RX`, `$RV`, `$RB`, … */
const STREAMING_INSTRUCTION = /^\$R[A-Z]$/;

/** A script file's path, as opposed to the page document's. */
const SCRIPT_FILE = /\.[cm]?js$/;

function pathOf(filename: string): string {
  return filename.split(/[?#]/, 1)[0] ?? filename;
}

/**
 * True when the event's innermost frame is one of React's inline streaming
 * instructions, running from the page document.
 */
export function isOrphanedStreamingInstruction(event: ErrorEvent): boolean {
  const values = event.exception?.values ?? [];
  const frames = values[values.length - 1]?.stacktrace?.frames ?? [];
  // Sentry orders frames oldest-first: the innermost call is the LAST one.
  const innermost = frames[frames.length - 1];
  if (!innermost?.function || !innermost.filename) return false;
  return (
    STREAMING_INSTRUCTION.test(innermost.function) && !SCRIPT_FILE.test(pathOf(innermost.filename))
  );
}

/**
 * A Sentry `beforeSend` for the browser that drops a React streaming
 * instruction's echo of an already-reported hydration failure, and passes
 * everything else through untouched.
 */
export function dropOrphanedStreamingInstructions(event: ErrorEvent): ErrorEvent | null {
  return isOrphanedStreamingInstruction(event) ? null : event;
}
