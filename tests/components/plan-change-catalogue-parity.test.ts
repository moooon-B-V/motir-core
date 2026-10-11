import { describe, expect, it } from 'vitest';
import { compareMessageShape } from '@/scripts/i18n/messageShape';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// THE ACT AND NARRATION CATALOGUES, en and zh, key for key (Story MOTIR-7974 ·
// MOTIR-7979; Story MOTIR-8060 · MOTIR-8064). A zh key missing beside its en twin
// would render the English fallback inside a Chinese rail, and a key whose
// placeholders differ would format a hole — neither shows until a person watches
// a real plan, so this pins both.
//
// The per-call lines' `act.call.*` catalogue is retired with the lines
// (`design/ai-chat/design-notes.md` § "⭐ Planner narration in the chat panel"),
// and the last test pins that it stays gone.

function flatten(node: unknown, prefix: string, out: Map<string, unknown>) {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, node);
  }
  return out;
}

const act = (messages: unknown) => {
  const conversation = (
    messages as { planningWorkspace: { conversation: { act: unknown; narration: unknown } } }
  ).planningWorkspace.conversation;
  return flatten({ act: conversation.act, narration: conversation.narration }, '', new Map());
};

const EN = act(en);
const ZH = act(zh);

describe('the act and narration catalogues — en and zh, key for key', () => {
  it('every key exists in both locales, and every value is a non-empty string', () => {
    expect([...EN.keys()].filter((k) => !ZH.has(k))).toEqual([]);
    expect([...ZH.keys()].filter((k) => !EN.has(k))).toEqual([]);
    for (const [key, value] of [...EN, ...ZH]) {
      expect(typeof value, key).toBe('string');
      expect((value as string).trim().length, key).toBeGreaterThan(0);
    }
  });

  it('every key keeps its placeholders and plural shape across locales', () => {
    const broken = [...EN].flatMap(([key, source]) =>
      compareMessageShape(source as string, ZH.get(key) as string, 'zh').map(
        (v) => `${key}: ${v.kind}${v.name ? `:${v.name}` : ''}`,
      ),
    );
    expect(broken).toEqual([]);
  });

  it('the retired per-call and lookup catalogues are gone from both locales', () => {
    expect([...EN.keys(), ...ZH.keys()].filter((k) => k.startsWith('act.call.'))).toEqual([]);
    // MOTIR-8158: the lookup rows and their strings are gone too.
    for (const gone of ['act.family.codeRead', 'act.retrievalLine', 'act.unknownLine']) {
      expect(EN.has(gone), gone).toBe(false);
    }
    expect(EN.has('narration.groupFinished')).toBe(true);
  });
});
