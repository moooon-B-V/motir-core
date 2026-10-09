import { describe, expect, it } from 'vitest';
import { CALL_TOOL_PLACEHOLDER } from '@/components/planning/planCallLines';
import { TOOL_CALL_FAMILIES } from '@/lib/planning/planChangeFrames';
import { compareMessageShape } from '@/scripts/i18n/messageShape';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// THE ACT CATALOGUE, en and zh, key for key (Story MOTIR-7974 · MOTIR-7979, and
// the parity MOTIR-7981 asks of the story gate). A zh key missing beside its en
// twin would render the English fallback inside a Chinese rail, and a key whose
// placeholders differ would format a hole — neither shows until a person watches
// a real plan, so this pins both.

/**
 * The tools MOTIR-7975's copy table enumerated, copied from
 * `design/ai-chat/design-notes.md` § "Copy, en and zh, keyed on what each tool
 * DOES" — taken at motir-ai `97e73fb` (`main`), the 18 retrieval tools and the
 * walk's 22 session tools. Written out rather than read from the component, so a
 * tool dropped from the component's table fails here.
 */
const DESIGN_TOOLS = [
  'skeleton',
  'search_work_items',
  'search_work_items_semantic',
  'get_item',
  'get_subtree',
  'walk_blocking',
  'code_search',
  'code_explore',
  'code_callers',
  'code_callees',
  'code_impact',
  'code_node',
  'get_coding_convention',
  'get_code_health',
  'read_file',
  'list_changed_files',
  'web_search',
  'search_lessons',
  'lay',
  'drill_into',
  'propose_node',
  'complete_level',
  'target_already_covered',
  'author',
  'deepen_node',
  'raise_gap',
  'add_item',
  'update_item',
  'remove_item',
  'log_bug',
  'validate_plan',
  'settle_conversation',
  'ask_user',
  'clear_plan',
  'search_planning_rules',
  'report_findings',
  'log_planning_mistake',
  'log_planning_bug',
  'classify_revision',
  'return_to_conversation',
];

function flatten(node: unknown, prefix: string, out: Map<string, unknown>) {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, node);
  }
  return out;
}

const act = (messages: unknown) =>
  flatten(
    (messages as { planningWorkspace: { conversation: { act: unknown } } }).planningWorkspace
      .conversation.act,
    '',
    new Map(),
  );

const EN = act(en);
const ZH = act(zh);

describe('the act catalogue — en and zh, key for key', () => {
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

  it('every tool in the design’s copy table has a line, and the component reads exactly those', () => {
    expect(Object.keys(CALL_TOOL_PLACEHOLDER).sort()).toEqual([...DESIGN_TOOLS].sort());
    for (const tool of DESIGN_TOOLS) {
      expect(EN.has(`call.tool.${tool}`), tool).toBe(true);
      const placeholder = CALL_TOOL_PLACEHOLDER[tool];
      const line = EN.get(`call.tool.${tool}`) as string;
      if (placeholder === null) expect(line, tool).not.toMatch(/\{/);
      else expect(line, tool).toContain(`{${placeholder}}`);
    }
  });

  it('every family has a generic line, and so does a call with none', () => {
    for (const family of TOOL_CALL_FAMILIES) {
      expect(EN.has(`call.family.${family}`), family).toBe(true);
    }
    expect(EN.has('call.family.none')).toBe(true);
    expect(EN.has('family.codeRead')).toBe(true);
  });
});
