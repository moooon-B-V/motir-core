import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { projectsService } from '@/lib/services/projectsService';
import { projectLessonsService } from '@/lib/services/projectLessonsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { ReinforcedLessonDTO } from '@/lib/dto/projectLessons';
import type { McpContextResolver } from '../context';
import { toToolError, toolOk } from '../toolResult';
import { exempt } from '../payloads/define';
import { projectKeyField } from './sprintRef';

// `reinforce_lesson` (Subtask MOTIR-3553 · Bug MOTIR-3547) — record that a
// mistake described by an existing lesson has just happened again. The WRITE
// half of `search_lessons`: that tool tells an agent what went wrong before,
// and until this one there was no way to say that any of it applied.
//
// A thin adapter over `projectLessonsService.reinforceLesson`, following
// `addLesson.ts` exactly: resolve the context, call the service, `toolOk` /
// `toToolError`. No business logic — the permission check, the project
// resolution and the both-scopes lesson lookup all belong to the service and
// the upstream, so the next caller inherits them.
//
// ⚠️ THE DESCRIPTION IS THE ENFORCEMENT MECHANISM, not documentation, and that
// is unusual enough to say out loud. The rule this tool exists to install is a
// DISCRIMINATOR no schema can express: the store cannot tell whether an
// occurrence really happened, because only the caller was there. So the sentence
// that teaches WHEN to call is load-bearing in a way the argument list is not,
// and an agent that calls it after every search is strictly worse than one that
// never calls it at all — it would fabricate occurrences at corpus scale and
// turn `recurrenceCount` into a measure of how often the corpus was CONSULTED
// rather than how often each mistake RECURRED.
//
// ⚠️ NOT `lesson:manage`. That key is what `add_lesson` and retiring take, and
// both CHANGE the standing instructions the planner is given. This changes
// nothing a lesson says; see `canReinforceLessons` for why folding the two would
// mean a routine run had to be able to retire a lesson in order to record that
// one applied.

export const REINFORCE_LESSON_TOOL_NAME = 'reinforce_lesson';

const DESCRIPTION =
  'THIS MISTAKE JUST HAPPENED AGAIN. Record that a lesson you already found — ' +
  'through `search_lessons` — describes something that actually went wrong on ' +
  'this run. That is the whole trigger, and it is about an EVENT, not about a ' +
  'document.\n\n' +
  'WHEN TO CALL IT. You searched the lessons, you hit a real problem, and one of ' +
  'the rows that came back is about THAT problem. Call it then — **whether or ' +
  'not you go on to change the lesson**. Deciding the lesson already covers the ' +
  'case perfectly is the strongest possible evidence about it, and it counts ' +
  'exactly as much as widening the wording does. The edit is optional; the ' +
  'record is not.\n\n' +
  '⚠️ WHEN NOT TO CALL IT — and this matters more than when to. A search that ' +
  'merely RETURNED rows is not a hit: every run reads a handful of lessons, and ' +
  'almost none of them describe what actually happened. Tidying the library is ' +
  'not a hit either — rewording a lesson, retagging one, or broadening its axes ' +
  'during a cleanup pass with no incident behind it must record NOTHING. A ' +
  'reinforcement with no occurrence behind it invents one, and the count it ' +
  'feeds is what a reader uses to tell the third recurrence of one known ' +
  'mistake from three unrelated ones.\n\n' +
  'WHY IT MATTERS. Lessons age out: one nobody has hit in months stops being ' +
  'injected, to make room for ones that keep happening. That only works if the ' +
  'hits are recorded — otherwise the lessons being relied on most look exactly ' +
  'like the ones nobody has read since they were written.\n\n' +
  'IDEMPOTENT, and you can rely on that. `occurrenceRef` names the EVENT — the ' +
  'work item you are running, the bug you just filed. Recording the same event ' +
  'twice writes nothing the second time and answers `counted: false`, which is a ' +
  'normal answer and not an error. One occurrence counts once, however many ' +
  'times it is reported and through whichever door.';

/** Render the outcome: what was reinforced, and whether this call is what counted. */
export function summarizeReinforcement(lesson: ReinforcedLessonDTO): string {
  if (!lesson.counted) {
    return (
      `Already recorded — "${lesson.title}" (${lesson.scope}) has this occurrence on its ` +
      `ledger, so nothing was written and the count stands at ${lesson.recurrenceCount}. ` +
      `This is a re-report of one event, not a further recurrence.`
    );
  }
  return (
    `Reinforced "${lesson.title}" (${lesson.scope}). Occurrences including this one: ` +
    `${lesson.recurrenceCount}. Its clock is bumped, so it is back in the lesson search ` +
    `if it had aged out.`
  );
}

/** The adapter: resolve the project by key, then record the occurrence. */
export async function runReinforceLesson(
  args: { projectKey: string; lessonId: string; occurrenceRef: string },
  ctx: ServiceContext,
): Promise<CallToolResult> {
  try {
    const project = await projectsService.getByKey(args.projectKey.trim().toUpperCase(), ctx);
    const lesson = await projectLessonsService.reinforceLesson(project.id, ctx, {
      lessonId: args.lessonId.trim(),
      occurrenceRef: args.occurrenceRef.trim(),
    });
    return toolOk(
      summarizeReinforcement(lesson),
      // EXEMPT for the same reason its two siblings are: no `/api/v1` operation
      // returns a lesson at all, so there is no shared resource schema to derive
      // from. `counted` is the load-bearing member — a caller reading the
      // payload structurally must be able to tell "recorded" from "already
      // recorded" without parsing the prose.
      exempt(REINFORCE_LESSON_TOOL_NAME, {
        id: lesson.id,
        title: lesson.title,
        scope: lesson.scope,
        lastOccurredAt: lesson.lastOccurredAt,
        recurrenceCount: lesson.recurrenceCount,
        counted: lesson.counted,
      }),
    );
  } catch (err) {
    return toToolError(err);
  }
}

export function registerReinforceLesson(
  server: McpServer,
  resolveContext: McpContextResolver,
): void {
  server.registerTool(
    REINFORCE_LESSON_TOOL_NAME,
    {
      title: 'Reinforce a lesson',
      description: DESCRIPTION,
      inputSchema: {
        projectKey: projectKeyField,
        lessonId: z
          .string()
          .min(1)
          .describe(
            'The lesson this occurrence matched — the `id` `search_lessons` returns for each ' +
              'ranked row. Take it from that result; do not construct one.',
          ),
        occurrenceRef: z
          .string()
          .min(1)
          .describe(
            'YOUR identifier for the EVENT that just happened — the work item you are running ' +
              '(`MOTIR-123`), or the bug you filed for it. It is what makes this idempotent: the ' +
              'same event recorded twice counts once. It names the occurrence, NOT the lesson.',
          ),
      },
    },
    async (args, extra) => {
      try {
        return await runReinforceLesson(args, resolveContext(extra));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
