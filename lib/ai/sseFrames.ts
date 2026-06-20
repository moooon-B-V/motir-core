// Client-side Server-Sent-Events frame parsing — shared by every browser
// consumer of a motir-ai job stream (the `useExplanationDraft` draft hook and the
// `useDiscoveryChat` onboarding loop). The server side has its own parser in
// `lib/ai/motirAiClient.ts` (Node stream); this is the DOM `fetch().body` reader
// counterpart. Pure + browser-safe (no imports) so it unit-tests trivially.
//
// Frames are `event: <name>\ndata: <json>\n\n` (see the chat/explanation stream
// routes' `formatFrame`). A frame may carry a multi-line `data:`; comment lines
// (`:`-prefixed keep-alives) are ignored. `data` is JSON-parsed when possible,
// else left as the raw string.

export interface SseFrame {
  event: string;
  data: unknown;
}

/** Parse one raw SSE frame (no trailing blank line) into `{ event, data }`, or
 *  `null` when it carries no `data:` line. */
export function parseSseFrame(frame: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (dataLines.length === 0) return null;
  const rawData = dataLines.join('\n');
  let data: unknown = rawData;
  try {
    data = JSON.parse(rawData);
  } catch {
    // leave as the raw string
  }
  return { event, data };
}

/** Split a decoded chunk buffer into complete frames (separated by a blank
 *  line), returning the parsed frames + the unconsumed remainder to carry into
 *  the next read. */
export function drainSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  let sep = rest.indexOf('\n\n');
  while (sep !== -1) {
    const raw = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const parsed = parseSseFrame(raw);
    if (parsed) frames.push(parsed);
    sep = rest.indexOf('\n\n');
  }
  return { frames, rest };
}
