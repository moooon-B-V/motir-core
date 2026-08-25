import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { projectLessonsService } from '@/lib/services/projectLessonsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ProjectLessonDTO } from '@/lib/dto/projectLessons';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `add_lesson` (Story MOTIR-3331 · Subtask MOTIR-3361) — record a lesson for a
// project, so future plans for it are given the lesson. A thin adapter over
// `projectLessonsService.addLesson` (MOTIR-3360), following `addComment.ts`
// exactly: resolve the context, call the service, `toolOk` / `toToolError`. NO
// business logic here — the permission check, the project resolution and the
// tenant scoping all belong to the service, so the next caller inherits them.
//
// ⚠️ THE DESCRIPTIONS ARE THE DELIVERABLE, not the plumbing. A tool description
// is the ENTIRE briefing the calling agent gets: no onboarding, no docs it will
// read, no second chance. "Add a lesson to the project's lesson library" would
// fill the store with restatements of what just happened, one-off incidents and
// things already in the plan — and a store nobody can tell signal from noise in
// is the thing this epic exists to prevent. So the text below is written for a
// model that has never seen this product, and it is reviewed as WRITING.
//
// ⚠️ THE SCHEMA IS DELIBERATELY LEFT STRICT. Since MOTIR-3342 (#2241),
// `lib/mcp/strictInput.ts` rewrites every tool's `inputSchema` to `strict` at
// the registration seam, so an unknown key is REFUSED BY NAME instead of
// silently dropped. `.passthrough()` and `.catchall()` are exempt from that
// rewrite — declaring either here would opt this tool back out of the guard,
// quietly, and `scope` is exactly the key that would then find its way through.
// There is no such argument, and that is the contract, not an oversight: a
// lesson that applies to every project is Motir's own curated corpus and is
// added by migration.
//
// ⚠️ NOT `log_planning_mistake`. That is motir-ai's INTERNAL tool, called by the
// planner during a run, and it is untouched by this. This is the agent-facing
// door on motir-core's MCP surface.

export const ADD_LESSON_TOOL_NAME = 'add_lesson';

/** The store's routing-axis vocabularies, mirrored from motir-ai's enums. */
const LESSON_KINDS = ['epic', 'story', 'task', 'bug', 'subtask'] as const;
const LESSON_TYPES = [
  'code',
  'design',
  'test',
  'content',
  'copy',
  'translate',
  'research',
  'review',
  'verification',
  'decision',
  'deploy',
  'manual',
  'legal',
  'chore',
] as const;
const LESSON_PHASES = ['skeleton', 'deepen'] as const;
const MISTAKE_TYPES = ['onboarding_planning', 'regular_planning', 'planning_craft'] as const;

const inputSchema = {
  projectKey: projectKeyField,
  title: z
    .string()
    .min(1)
    .describe(
      'The takeaway, in one line — the thing a planner should do differently, not a headline for ' +
        'an incident. "Pin the target repository on every card that ships code" is a lesson; ' +
        '"Repository problems in the billing epic" is a label for one.',
    ),
  body: z
    .string()
    .min(1)
    .describe(
      'What goes wrong, stated so it is recognisable the NEXT time rather than recounted from ' +
        'the last. Describe the situation and the failure, not the specific work items it ' +
        'happened to involve.',
    ),
  why: z
    .string()
    .min(1)
    .describe(
      'Why it matters — the cost of getting it wrong. This is the one field that may carry the ' +
        'specifics of your own case (what it cost, when, on which work), because it is what ' +
        'justifies the rule rather than what a future plan is matched against.',
    ),
  howToApply: z
    .string()
    .min(1)
    .describe(
      'The actionable rule, addressed to a future planner in the second person: "Before sealing ' +
        'a card that ships code, set its target repository." Not a restatement of the body — if ' +
        'this field reads like the body, the lesson has no rule in it.',
    ),
  mistakeType: z
    .enum(MISTAKE_TYPES)
    .default('regular_planning')
    .describe(
      'Which kind of planning this lesson is for: "regular_planning" (planning an existing ' +
        'project — the usual answer), "onboarding_planning" (drafting a project\'s first tree), ' +
        'or "planning_craft" (how to plan well, whatever is being planned).',
    ),
  kinds: z
    .array(z.enum(LESSON_KINDS))
    .optional()
    .describe(
      'WHICH WORK-ITEM KINDS this lesson is about, and one of the three axes that decide when a ' +
        'future plan is shown it. LEAVING IT OUT MEANS "every kind" — occasionally right, and ' +
        'usually the reason a lesson turns up in plans it has nothing to do with. Say what you ' +
        'mean on each axis rather than skipping it.',
    ),
  types: z
    .array(z.enum(LESSON_TYPES))
    .optional()
    .describe(
      'WHICH WORK TYPES this lesson is about (code, design, test, …). Leaving it out means ' +
        '"every type". Under-claiming is as wrong as over-claiming: a lesson typed only "code" ' +
        'stops reaching the chore work it also applies to.',
    ),
  phases: z
    .array(z.enum(LESSON_PHASES))
    .optional()
    .describe(
      'WHICH PLANNING PHASE this lesson is about: "skeleton" (laying out titles and ' +
        'dependencies) or "deepen" (writing a card\'s body). Leaving it out means both.',
    ),
  sourceRef: z
    .string()
    .optional()
    .describe(
      'Where this lesson came from — a work-item key, a runbook name, a ticket. Also the ' +
        'idempotency key: adding the same lesson again with the same sourceRef returns the ' +
        'existing one instead of a duplicate.',
    ),
};

/** Compact human-readable summary of a newly-recorded lesson. */
function summarize(projectKey: string, lesson: ProjectLessonDTO): string {
  const axes = [
    lesson.kinds.length > 0 ? `kinds ${lesson.kinds.join('/')}` : null,
    lesson.types.length > 0 ? `types ${lesson.types.join('/')}` : null,
    lesson.phases.length > 0 ? `phases ${lesson.phases.join('/')}` : null,
  ].filter(Boolean);
  const routing = axes.length > 0 ? axes.join(' · ') : 'applies to every card';
  return [
    `Recorded a lesson for ${projectKey} (${routing}).`,
    lesson.title,
    'Future plans for this project will be given it.',
  ].join('\n');
}

/** The adapter: resolve the project by key, then record the lesson. */
export async function runAddLesson(
  args: {
    projectKey: string;
    title: string;
    body: string;
    why: string;
    howToApply: string;
    mistakeType: (typeof MISTAKE_TYPES)[number];
    kinds?: (typeof LESSON_KINDS)[number][];
    types?: (typeof LESSON_TYPES)[number][];
    phases?: (typeof LESSON_PHASES)[number][];
    sourceRef?: string;
  },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
    const lesson = await projectLessonsService.addLesson(project.id, ctx, {
      mistakeType: args.mistakeType,
      title: args.title,
      body: args.body,
      why: args.why,
      howToApply: args.howToApply,
      ...(args.kinds ? { kinds: args.kinds } : {}),
      ...(args.types ? { types: args.types } : {}),
      ...(args.phases ? { phases: args.phases } : {}),
      ...(args.sourceRef ? { sourceRef: args.sourceRef } : {}),
    });
    return toolOk(
      summarize(project.identifier, lesson),
      // EXEMPT: no `/api/v1` operation returns a lesson, so there is no shared
      // resource schema to derive from (see `payloads/exemptions.ts`). The
      // payload carries what a calling agent can act on — the id to reference
      // it by, and the axes AS STORED, so an agent can see that an axis it left
      // out came back empty and means "everything".
      exempt(ADD_LESSON_TOOL_NAME, {
        id: lesson.id,
        title: lesson.title,
        kinds: lesson.kinds,
        types: lesson.types,
        phases: lesson.phases,
        sourceRef: lesson.sourceRef,
      }),
    );
  } catch (err) {
    // Everything propagates as the service raised it — including the upstream's
    // near-duplicate refusal, which NAMES the existing lesson's id and title.
    // Flattening that into "could not create" would turn the one actionable
    // answer this tool can give into a dead end.
    return toToolError(err);
  }
}

export function registerAddLesson(server: McpServer, resolveContext: McpContextResolver): void {
  server.registerTool(
    ADD_LESSON_TOOL_NAME,
    {
      title: 'Add lesson',
      description:
        'Record a LESSON for this project: something that went wrong when planning it and will go ' +
        'wrong again, so that later plans for this project are given the lesson before they are ' +
        'drafted. Write it as a standing instruction to a future planner, not as a report about ' +
        'what just happened. ' +
        'It belongs to THIS project only — it is never shared with any other project, and it is ' +
        'not a way to change how Motir plans in general. ' +
        'The three routing axes (kinds, types, phases) decide which future plans are shown it; ' +
        'leaving an axis out means "applies to everything on that axis", which is occasionally ' +
        'right and usually means the lesson surfaces where it does not belong. ' +
        'DO NOT add one for: a one-off that will not recur; something an existing lesson already ' +
        "covers (read the project's lessons first); or a defect in the product, which is a bug " +
        'report rather than a lesson. A near-duplicate is refused, naming the lesson that already ' +
        "covers it. Requires permission to change this project's lesson library.",
      inputSchema,
    },
    async (args, extra) => runAddLesson(args, resolveContext(extra)),
  );
}
