// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useExplanationDraft } from '@/lib/hooks/useExplanationDraft';

// Story MOTIR-7734 · MOTIR-8744 — the draft hook keeps the LANGUAGE the terminal
// `explanation` frame names (`draftLanguage`), so the form can save the draft
// with it. The two `fetch`es (submit, then the SSE stream) are stubbed; the hook
// and its frame parsing are real.

function sse(frames: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const body = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

/** Stub one draft: the submit answers a job id, the stream answers `frame`. */
function stubDraft(frame: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/stream')
        ? new Response(sse([{ event: 'explanation', data: frame }]), { status: 200 })
        : new Response(JSON.stringify({ jobId: 'job-1' }), { status: 200 }),
    ),
  );
}

function draftHook() {
  return renderHook(() =>
    useExplanationDraft({
      onText: () => {},
      getContext: () => ({ title: 'Export the report' }),
    }),
  );
}

async function draft(result: ReturnType<typeof draftHook>['result']) {
  act(() => result.current.start());
  await waitFor(() => expect(result.current.isDrafting).toBe(false));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useExplanationDraft — the draft’s language', () => {
  it('keeps the frame’s language with the draft', async () => {
    stubDraft({ explanationMd: '매주 필요합니다.', language: 'ko' });
    const { result } = draftHook();
    await draft(result);
    expect(result.current.draftBaseline).toBe('매주 필요합니다.');
    expect(result.current.draftLanguage).toBe('ko');
  });

  it('a frame with no language, or one outside the eleven codes, leaves it null', async () => {
    stubDraft({ explanationMd: 'Needed weekly.' });
    const { result } = draftHook();
    await draft(result);
    expect(result.current.draftLanguage).toBeNull();

    stubDraft({ explanationMd: 'Needed weekly.', language: 'xx' });
    await draft(result);
    expect(result.current.draftLanguage).toBeNull();
  });

  it('a regenerate replaces it with the new frame’s, and reset() clears it', async () => {
    stubDraft({ explanationMd: '每周都需要。', language: 'zh' });
    const { result } = draftHook();
    await draft(result);
    expect(result.current.draftLanguage).toBe('zh');

    stubDraft({ explanationMd: 'Jede Woche nötig.', language: 'de' });
    await draft(result);
    expect(result.current.draftLanguage).toBe('de');

    act(() => result.current.reset());
    expect(result.current.draftLanguage).toBeNull();
    expect(result.current.draftBaseline).toBeNull();
  });
});
