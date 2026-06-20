import { describe, expect, it } from 'vitest';
import { drainSseFrames, parseSseFrame } from '@/lib/ai/sseFrames';

describe('parseSseFrame', () => {
  it('parses an event + JSON data frame', () => {
    expect(parseSseFrame('event: assistant\ndata: {"text":"hi"}')).toEqual({
      event: 'assistant',
      data: { text: 'hi' },
    });
  });

  it('defaults the event to "message" and leaves non-JSON data as a string', () => {
    expect(parseSseFrame('data: plain')).toEqual({ event: 'message', data: 'plain' });
  });

  it('ignores comment (keep-alive) lines and joins multi-line data', () => {
    expect(parseSseFrame(': keep-alive\nevent: docs\ndata: {"a":1}')).toEqual({
      event: 'docs',
      data: { a: 1 },
    });
  });

  it('returns null for a frame with no data line', () => {
    expect(parseSseFrame('event: status')).toBeNull();
  });
});

describe('drainSseFrames', () => {
  it('splits complete frames and returns the unconsumed remainder', () => {
    const buf =
      'event: assistant\ndata: {"text":"a"}\n\nevent: status\ndata: {"phase":"drafting"}\n\nevent: assistant\ndata: {"text":"b"';
    const { frames, rest } = drainSseFrames(buf);
    expect(frames).toEqual([
      { event: 'assistant', data: { text: 'a' } },
      { event: 'status', data: { phase: 'drafting' } },
    ]);
    // the third frame is incomplete (no trailing blank line) → carried over
    expect(rest).toBe('event: assistant\ndata: {"text":"b"');
  });

  it('returns no frames when the buffer holds no complete frame', () => {
    const { frames, rest } = drainSseFrames('event: assistant\ndata: {"text":"a"}');
    expect(frames).toEqual([]);
    expect(rest).toBe('event: assistant\ndata: {"text":"a"}');
  });
});
