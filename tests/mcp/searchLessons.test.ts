import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TOOL_PERMISSIONS, CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import type { LessonSearchResult } from '@/lib/dto/projectLessons';

// `search_lessons` (Story MOTIR-3466 · Subtask MOTIR-3480) — the tool's own
// unit-level criteria: the gate, the grant, the refusal, the three outcomes and
// the description that has to teach narrow-by-axis-then-ask.
//
// The seam below it (MOTIR-3478) has its own spec, and the REAL TRANSPORT is
// MOTIR-3481's. This file calls the adapter directly.

const searchLessons =
  vi.fn<
    (projectId: string, ctx: unknown, input: Record<string, unknown>) => Promise<LessonSearchResult>
  >();
const getByKey = vi.fn();
const enforceAiRateLimit = vi.fn<() => Promise<Response | null>>();

vi.mock('@/lib/services/projectLessonsService', () => ({
  projectLessonsService: {
    searchLessons: (...a: unknown[]) => searchLessons(...(a as Parameters<typeof searchLessons>)),
  },
}));
vi.mock('@/lib/services/projectsService', () => ({
  projectsService: { getByKey: (...a: unknown[]) => getByKey(...(a as [])) },
}));
vi.mock('@/lib/rateLimit/aiGuard', () => ({
  enforceAiRateLimit: (...a: unknown[]) => enforceAiRateLimit(...(a as [])),
}));

const {
  runSearchLessons,
  summarizeLessonSearch,
  registerSearchLessons,
  SEARCH_LESSONS_TOOL_NAME,
  NO_LESSON_MATCHED_MESSAGE,
  LESSON_CORPUS_UNAVAILABLE_MESSAGE,
} = await import('@/lib/mcp/tools/searchLessons');

const ctx = { userId: 'u1', workspaceId: 'ws1' } as never;

function lesson(over: Record<string, unknown> = {}) {
  return {
    id: 'les_1',
    title: 'a count taken from a working tree is not a property of the ref',
    body: 'Somebody counted with `find` over a tree they had been editing.',
    howToApply: 'Re-measure on a ref — `git ls-tree` — before quoting a number.',
    scope: 'global',
    kinds: [],
    types: ['code'],
    phases: ['deepen'],
    distance: 0.12,
    ...over,
  };
}

const ARGS = { projectKey: 'PROD', query: 'counting a population from a working tree' };

/** The rendered prose, unescaped — `JSON.stringify` would escape the quotes the
 *  unavailable message deliberately contains. */
function renderedText(res: { content?: unknown }): string {
  return ((res.content as { text?: string }[]) ?? []).map((c) => c.text ?? '').join('\n');
}

/** The registered tool's own metadata, as an MCP client would read it. */
function registeredTool() {
  let captured: { name: string; config: Record<string, unknown> } | undefined;
  const server = {
    registerTool(name: string, config: Record<string, unknown>) {
      captured = { name, config };
    },
  };
  registerSearchLessons(server as never, () => ctx);
  return captured!;
}

beforeEach(() => {
  vi.clearAllMocks();
  getByKey.mockResolvedValue({ id: 'pj_1', identifier: 'PROD' });
  enforceAiRateLimit.mockResolvedValue(null);
  searchLessons.mockResolvedValue({ outcome: 'matched', lessons: [lesson()] } as never);
});
afterEach(() => vi.restoreAllMocks());

describe('registration, permission and scope', () => {
  it('is registered under its stable name', () => {
    expect(MCP_TOOL_NAMES).toContain(SEARCH_LESSONS_TOOL_NAME);
    expect(registeredTool().name).toBe('search_lessons');
  });

  it('is gated on the lesson READ key — asserted, not assumed', () => {
    expect(TOOL_PERMISSIONS.search_lessons).toBe('lesson:view');
  });

  it('is NOT gated on the manage key — the read/manage split must survive', () => {
    // An admin holds both, so a manual walk and every E2E pass either way. This
    // is the assertion that fails for the role nobody has created yet.
    expect(TOOL_PERMISSIONS.search_lessons).not.toBe(TOOL_PERMISSIONS.add_lesson);
    expect(TOOL_PERMISSIONS.add_lesson).toBe('lesson:manage');
  });

  it('files under the legacy READ scope, beside its write sibling', () => {
    expect(TOOL_SCOPES.search_lessons).toBe('read');
  });
});

describe('⚠️ CLI_TOKEN_GRANT carries the read key — the failure that ships GREEN', () => {
  it('includes `lesson:view`', () => {
    // Without this the tool registers, every suite passes against a workspace
    // PAT, and the one caller this story was built for — a sandboxed `motir run`
    // agent — gets a refusal it will read as an outage.
    expect(CLI_TOKEN_GRANT).toContain('lesson:view');
  });

  it('carries the key this tool ACTUALLY asserts, not a hard-coded name', () => {
    // Stated as the relationship rather than as the literal, so renaming the
    // permission cannot leave a passing test beside a broken grant.
    expect(CLI_TOKEN_GRANT).toContain(TOOL_PERMISSIONS.search_lessons);
  });

  it('is not widened any further than the read — no lesson WRITE from a CLI token', () => {
    expect(CLI_TOKEN_GRANT).not.toContain('lesson:manage');
  });
});

describe('the money gate runs AFTER the browse gate and BEFORE the search', () => {
  it('resolves the project first, then spends the allowance, then searches', async () => {
    await runSearchLessons(ARGS, ctx);
    const order = [
      getByKey.mock.invocationCallOrder[0]!,
      enforceAiRateLimit.mock.invocationCallOrder[0]!,
      searchLessons.mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('spends nothing when the project does not resolve', async () => {
    const { ProjectNotFoundError } = await import('@/lib/projects/errors');
    getByKey.mockRejectedValue(new ProjectNotFoundError('PROD'));
    const res = await runSearchLessons(ARGS, ctx);
    expect(res.isError).toBe(true);
    // A caller who cannot browse the project never spends the owner's budget.
    expect(enforceAiRateLimit).not.toHaveBeenCalled();
    expect(searchLessons).not.toHaveBeenCalled();
  });

  it('refuses as a TOOL ERROR, not a throw, when the allowance is exhausted', async () => {
    enforceAiRateLimit.mockResolvedValue(
      new Response(null, { status: 429, headers: { 'Retry-After': '30' } }),
    );
    const res = await runSearchLessons(ARGS, ctx);
    expect(res.isError).toBe(true);
    expect(renderedText(res)).toContain('30');
    expect(searchLessons).not.toHaveBeenCalled();
  });
});

describe('the three outcomes reach the caller', () => {
  it('MATCHED — the text, the scope and the axis tag', async () => {
    const res = await runSearchLessons(ARGS, ctx);
    const text = renderedText(res);
    expect(text).toContain('a count taken from a working tree');
    expect(text).toContain('Re-measure on a ref');
    expect(text).toContain('global');
    expect(text).toContain('types: code');
  });

  it('NOTHING MATCHED — a readable value, not an error and not an empty string', async () => {
    searchLessons.mockResolvedValue({ outcome: 'nothing-matched', lessons: [] });
    const res = await runSearchLessons(ARGS, ctx);
    expect(res.isError).toBeFalsy();
    expect(renderedText(res)).toContain(NO_LESSON_MATCHED_MESSAGE);
  });

  it('UNAVAILABLE — a DIFFERENT readable value a caller cannot mistake for the above', async () => {
    searchLessons.mockResolvedValue({ outcome: 'unavailable', lessons: [] });
    const res = await runSearchLessons(ARGS, ctx);
    expect(res.isError).toBeFalsy();
    expect(renderedText(res)).toContain(LESSON_CORPUS_UNAVAILABLE_MESSAGE);
  });

  it('the two empty messages are DIFFERENT and say opposite things', () => {
    expect(NO_LESSON_MATCHED_MESSAGE).not.toBe(LESSON_CORPUS_UNAVAILABLE_MESSAGE);
    // Not merely different strings: the unavailable one must actively warn
    // against the reading the other one invites.
    expect(LESSON_CORPUS_UNAVAILABLE_MESSAGE).toMatch(/not.*reached|could NOT BE REACHED/i);
    expect(LESSON_CORPUS_UNAVAILABLE_MESSAGE).toMatch(/nothing was searched/i);
    expect(NO_LESSON_MATCHED_MESSAGE).toMatch(/normal answer/i);
  });

  it('the OUTCOME rides the structured payload too, for a caller reading it structurally', async () => {
    for (const outcome of ['matched', 'nothing-matched', 'unavailable'] as const) {
      searchLessons.mockResolvedValue({
        outcome,
        lessons: outcome === 'matched' ? [lesson()] : [],
      } as never);
      const res = await runSearchLessons(ARGS, ctx);
      expect((res.structuredContent as { outcome: string }).outcome).toBe(outcome);
    }
  });

  it('renders an unconstrained lesson as such, so a caller can see WHY it came back', () => {
    const out = summarizeLessonSearch({
      outcome: 'matched',
      lessons: [lesson({ kinds: [], types: [], phases: [] })] as never,
    });
    expect(out).toContain('[unconstrained]');
  });
});

describe('the axes reach the seam, and an omitted one stays absent', () => {
  it('passes supplied axes and the limit through', async () => {
    await runSearchLessons(
      { ...ARGS, kinds: ['bug'], types: ['code'], phases: ['skeleton'], limit: 3 } as never,
      ctx,
    );
    expect(searchLessons.mock.calls[0]![2]).toMatchObject({
      kinds: ['bug'],
      types: ['code'],
      phases: ['skeleton'],
      limit: 3,
    });
  });

  it('omits an axis the caller did not name — never `[]`', async () => {
    await runSearchLessons(ARGS, ctx);
    const passed = searchLessons.mock.calls[0]![2];
    for (const axis of ['kinds', 'types', 'phases']) {
      expect(passed).not.toHaveProperty(axis);
    }
  });

  it('upper-cases and trims the project key before resolving it', async () => {
    await runSearchLessons({ ...ARGS, projectKey: '  prod ' }, ctx);
    expect(getByKey).toHaveBeenCalledWith('PROD', ctx);
  });
});

describe('an illegal axis value is refused with the legal set named', () => {
  it.each([
    ['kinds', ['epic', 'story', 'task', 'bug', 'subtask']],
    ['phases', ['skeleton', 'deepen']],
  ])('%s — the schema enumerates the legal members', (axis, legal) => {
    // The refusal is the SCHEMA's: `strictInput.ts` makes every tool's input
    // strict at the registration seam, and a zod enum rejects a non-member by
    // naming the set. Asserted on the shipped schema so it cannot silently widen
    // to `z.string()` and start dropping unknown values instead.
    const schema = registeredTool().config.inputSchema as Record<
      string,
      { parse(v: unknown): unknown }
    >;
    expect(() => schema[axis]!.parse(['not-a-member'])).toThrow();
    expect(schema[axis]!.parse(legal)).toEqual(legal);
  });

  it('requires a non-empty query', () => {
    const schema = registeredTool().config.inputSchema as Record<
      string,
      { parse(v: unknown): unknown }
    >;
    expect(() => schema['query']!.parse('')).toThrow();
  });

  it('bounds the limit', () => {
    const schema = registeredTool().config.inputSchema as Record<
      string,
      { parse(v: unknown): unknown }
    >;
    expect(() => schema['limit']!.parse(0)).toThrow();
    expect(() => schema['limit']!.parse(51)).toThrow();
    expect(schema['limit']!.parse(8)).toBe(8);
  });
});

describe('⚠️ THE DESCRIPTION IS A DELIVERABLE — it is the only briefing the caller gets', () => {
  const description = () => registeredTool().config.description as string;

  it('carries the retrieval arithmetic: the axes choose the pool, the query chooses which arrive', () => {
    const d = description();
    expect(d).toMatch(/axes only choose the candidate POOL/i);
    expect(d).toMatch(
      /query TEXT then\s+chooses which few arrive|query TEXT then chooses which few arrive/i,
    );
  });

  it('warns that a weak query returns noise that READS like the mechanism working', () => {
    // The specific hazard, not a generic "write a good query": an agent that
    // gets noise concludes the corpus is thin rather than that its query was.
    expect(description()).toMatch(/near-arbitrary rows out of a correctly-filtered\s+slice/i);
    expect(description()).toMatch(/reads as the mechanism working/i);
  });

  it('states the instruction in the form the card names', () => {
    expect(description()).toMatch(/Narrow by axis, THEN ask a real question/);
  });

  it('says what a LESSON IS, so the caller writes in the register the rows are stored in', () => {
    const d = description();
    expect(d).toMatch(/A LESSON IS A TAKEAWAY/i);
    // Both halves of the contrast — the register to use and the one to avoid.
    expect(d).toMatch(/not a property of the ref/);
    expect(d).toMatch(/board filter at scale/);
  });

  it('tells the caller the two empty outcomes are different', () => {
    const d = description();
    expect(d).toContain('nothing-matched');
    expect(d).toContain('unavailable');
    expect(d).toMatch(/NOT evidence that nothing applies/i);
  });

  it('declares that it costs an AI call', () => {
    expect(description()).toMatch(/COSTS AN AI CALL/i);
  });

  it('says it reads BOTH scopes — the property the whole story turns on', () => {
    expect(description()).toMatch(/shared corpus AND this project's own/i);
  });
});
