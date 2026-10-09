// A RECORDED per-call frame stream (Story MOTIR-7974 · MOTIR-7981).
//
// ⚠️ RECORDED, NOT HAND-WRITTEN. These are the frames motir-ai's own story gate
// (`tests/toolCallNarrationStoryGate.test.ts`, MOTIR-7980) emitted when it drove
// the REAL `plan` handler with its scripted model — PART 1's conversation, one lay
// session and three CONCURRENT author sessions — captured from its `emit` in
// order, with its own `effect:*` log lines (not frames) dropped and nothing else
// touched. Recorded 2026-10-09 at motir-ai `eb9ce1e` (branch
// `claude/project-thread-u37suv`, PR #684: the emitters are `74b6d9e` MOTIR-7977
// and `3de815f` MOTIR-7978), against motir-core's frame map at `f6b31b4`
// (`lib/planning/planChangeFrames.ts`, MOTIR-7976).
//
// What it holds that a hand-built list would not: the quiet frames a real run
// interleaves (`turn`, `status`, `lessons_injected`, `partition`, …), PART 1's
// calls arriving before any step, a failed read (`get_item` MOTIR-999) and five
// refused writes, and the three author sessions' calls INTERLEAVED — three
// starts, then three audits, then each session's write — so every mark has to
// find its own call by `callId`.
//
// To re-record: add a test to that motir-ai file that writes
// `run.log.filter((f) => !f.event.startsWith('effect:'))` to a file, run it, and
// paste the array here.

/** One SSE frame as motir-ai's job stream yields it. */
export interface RecordedFrame {
  event: string;
  data: unknown;
}

export const TOOL_CALL_STREAM: readonly RecordedFrame[] = [
  {
    event: 'conversation',
    data: {
      seededTarget: 'MOTIR-42',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: 'e4ed1e14-230a-4b58-8147-087da6f121ed',
      tool: 'report_findings',
      family: 'settle',
      verb: 'settle',
      object: {
        kind: 'none',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '4bf2df8b-8784-42ce-9e4e-aa1ee3c4b41f',
      tool: 'get_item',
      family: 'plan_tree',
      verb: 'look_up',
      object: {
        kind: 'item',
        value: 'MOTIR-42',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '61fe96cf-3ef2-459b-aa06-c61b98d35757',
      tool: 'search_work_items_semantic',
      family: 'plan_tree',
      verb: 'search',
      object: {
        kind: 'query',
        value: 'sign in',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: 'c871237b-1faa-4b43-9158-79cb3d5c5d49',
      tool: 'settle_conversation',
      family: 'settle',
      verb: 'settle',
      object: {
        kind: 'parent',
        value: 'MOTIR-42',
      },
      itemRef: null,
    },
  },
  {
    event: 'turn',
    data: {
      action: 'draft',
      message:
        'Searched the neighbourhood — nothing existing matches. Nothing covers it.\n\nPLANNING ONE TARGET: MOTIR-42 (lay)',
      outcome: 'nothing_matches',
      matchedKeys: [],
    },
  },
  {
    event: 'target_settled',
    data: {
      key: 'MOTIR-42',
      seededKey: 'MOTIR-42',
      entry: 'lay',
      kind: 'story',
      hasRequirement: true,
      settledBy: 'conversation',
      index: 0,
      of: 1,
    },
  },
  {
    event: 'search',
    data: {
      relatedCount: 0,
      total: 0,
    },
  },
  {
    event: 'target_read',
    data: {
      key: 'MOTIR-42',
      kind: 'story',
    },
  },
  {
    event: 'partition',
    data: {
      lockedCount: 0,
      mutableCount: 0,
    },
  },
  {
    event: 'neighbourhood',
    data: {
      target: 1,
      parent: 0,
      siblings: 0,
      children: 0,
      lockedDescendants: 0,
      mutableDescendants: 0,
      blocking: 0,
      related: 0,
      skeleton: 0,
      skeletonDropped: 0,
      total: 1,
      skeletonCap: 300,
    },
  },
  {
    event: 'pending_plans',
    data: {
      read: true,
      inFlight: 0,
      truncated: false,
    },
  },
  {
    event: 'retrieval_ready',
    data: {
      kind: 'augment',
      planTree: [
        'skeleton',
        'search_work_items_semantic',
        'search_work_items',
        'get_item',
        'get_subtree',
        'walk_blocking',
      ],
      codeGraph: [
        'code_explore',
        'code_search',
        'code_callers',
        'code_callees',
        'code_impact',
        'code_node',
      ],
      codeHealth: ['get_coding_convention', 'get_code_health'],
      codeRead: ['read_file', 'list_changed_files'],
      web: ['web_search'],
      lessons: ['search_lessons'],
      codeGraphIndexed: true,
      codeRepos: ['acme/web'],
    },
  },
  {
    event: 'lay',
    data: {
      target: 'MOTIR-42',
      depth: 0,
    },
  },
  {
    event: 'lessons_injected',
    data: {
      phase: 'regular_planning',
      cardPhase: 'lay',
      cardRef: 'MOTIR-42',
      lessonIds: [],
      count: 0,
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '60efebab-3539-498a-a803-af82c1230666',
      tool: 'report_findings',
      family: 'lay',
      verb: 'lay',
      object: {
        kind: 'none',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '4b72d4d1-6035-4ee7-b856-8cea14072aaa',
      tool: 'get_subtree',
      family: 'plan_tree',
      verb: 'look_up',
      object: {
        kind: 'item',
        value: 'MOTIR-42',
      },
      itemRef: null,
    },
  },
  {
    event: 'retrieval',
    data: {
      tool: 'get_subtree',
      family: 'plan_tree',
      ok: true,
      args: {
        rootKey: 'MOTIR-42',
      },
      callId: '4b72d4d1-6035-4ee7-b856-8cea14072aaa',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '2add8020-3b7a-4f7a-9f3e-ea2ab43762b9',
      tool: 'code_search',
      family: 'code_graph',
      verb: 'search',
      object: {
        kind: 'query',
        value: 'session cookie',
      },
      itemRef: null,
    },
  },
  {
    event: 'retrieval',
    data: {
      tool: 'code_search',
      family: 'code_graph',
      ok: true,
      args: {
        query: 'session cookie',
        repoRef: 'acme/web',
      },
      callId: '2add8020-3b7a-4f7a-9f3e-ea2ab43762b9',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '05471768-db6c-414d-a44f-129acce5855f',
      tool: 'get_coding_convention',
      family: 'code_health',
      verb: 'read',
      object: {
        kind: 'none',
      },
      itemRef: null,
    },
  },
  {
    event: 'retrieval',
    data: {
      tool: 'get_coding_convention',
      family: 'code_health',
      ok: true,
      args: {
        repoRef: 'acme/web',
      },
      callId: '05471768-db6c-414d-a44f-129acce5855f',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: 'f60be7a1-c91c-4ef1-8f75-d313c2c85ac0',
      tool: 'read_file',
      family: 'code_read',
      verb: 'read',
      object: {
        kind: 'path',
        value: 'lib/auth/session.ts',
      },
      itemRef: null,
    },
  },
  {
    event: 'retrieval',
    data: {
      tool: 'read_file',
      family: 'code_read',
      ok: true,
      args: {
        repoRef: 'acme/web',
        path: 'lib/auth/session.ts',
      },
      callId: 'f60be7a1-c91c-4ef1-8f75-d313c2c85ac0',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '8e60a9f0-32cf-4cef-a2af-7aca4c50d35d',
      tool: 'web_search',
      family: 'web',
      verb: 'search',
      object: {
        kind: 'query',
        value: 'oauth pkce',
      },
      itemRef: null,
    },
  },
  {
    event: 'retrieval',
    data: {
      tool: 'web_search',
      family: 'web',
      ok: true,
      args: {
        query: 'oauth pkce',
      },
      callId: '8e60a9f0-32cf-4cef-a2af-7aca4c50d35d',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '00c753ee-1b83-465d-8bab-c999ab42cb68',
      tool: 'search_lessons',
      family: 'lessons',
      verb: 'search',
      object: {
        kind: 'query',
        value: 'sign-in risk',
      },
      itemRef: null,
    },
  },
  {
    event: 'retrieval',
    data: {
      tool: 'search_lessons',
      family: 'lessons',
      ok: true,
      args: {
        query: 'sign-in risk',
      },
      callId: '00c753ee-1b83-465d-8bab-c999ab42cb68',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '618143c1-83f3-478b-82bd-55267532512c',
      tool: 'get_item',
      family: 'plan_tree',
      verb: 'look_up',
      object: {
        kind: 'item',
        value: 'MOTIR-999',
      },
      itemRef: null,
    },
  },
  {
    event: 'retrieval',
    data: {
      tool: 'get_item',
      family: 'plan_tree',
      ok: false,
      args: {
        key: 'MOTIR-999',
      },
      callId: '618143c1-83f3-478b-82bd-55267532512c',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '7e086d41-84ff-4e5c-a3d3-82243b7a7988',
      tool: 'lay',
      family: 'lay',
      verb: 'lay',
      object: {
        kind: 'parent',
        value: 'MOTIR-42',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call_failed',
    data: {
      callId: '7e086d41-84ff-4e5c-a3d3-82243b7a7988',
      reason: 'refused',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '5731ec51-f177-49cd-90de-e24d05e54e06',
      tool: 'propose_node',
      family: 'lay',
      verb: 'add',
      object: {
        kind: 'item',
        value: 'First leaf',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '780e09e3-34a9-489d-8c5e-a0734842381d',
      tool: 'propose_node',
      family: 'lay',
      verb: 'add',
      object: {
        kind: 'item',
        value: 'Second leaf',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: 'e006ccca-e933-4c3f-ad99-318bad3437ee',
      tool: 'propose_node',
      family: 'lay',
      verb: 'add',
      object: {
        kind: 'item',
        value: 'Third leaf',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: 'fd7bc47d-4d11-4092-975b-d65c6106533e',
      tool: 'add_item',
      family: 'item',
      verb: 'add',
      object: {
        kind: 'item',
        value: 'Session cookie not cleared',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call_failed',
    data: {
      callId: 'fd7bc47d-4d11-4092-975b-d65c6106533e',
      reason: 'refused',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '59f844a5-e517-4af3-937f-9add331534e6',
      tool: 'update_item',
      family: 'item',
      verb: 'update',
      object: {
        kind: 'none',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call_failed',
    data: {
      callId: '59f844a5-e517-4af3-937f-9add331534e6',
      reason: 'refused',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '099f593a-cea2-4ca7-9b0c-b7e94decd961',
      tool: 'remove_item',
      family: 'item',
      verb: 'remove',
      object: {
        kind: 'item',
        value: 'MOTIR-77',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call_failed',
    data: {
      callId: '099f593a-cea2-4ca7-9b0c-b7e94decd961',
      reason: 'refused',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '50acaf90-bfc3-4cd7-a7bf-e7bed595b3e9',
      tool: 'validate_plan',
      family: 'validate',
      verb: 'validate',
      object: {
        kind: 'none',
      },
      itemRef: null,
    },
  },
  {
    event: 'tool_call_failed',
    data: {
      callId: '50acaf90-bfc3-4cd7-a7bf-e7bed595b3e9',
      reason: 'refused',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '44711483-5170-4896-9903-4b8c392efd0c',
      tool: 'complete_level',
      family: 'lay',
      verb: 'lay',
      object: {
        kind: 'none',
      },
      itemRef: null,
    },
  },
  {
    event: 'level_complete',
    data: {
      parentRef: 'item_42',
      note: null,
    },
  },
  {
    event: 'level_complete',
    data: {
      parentRef: 'MOTIR-42',
      note: null,
    },
  },
  {
    event: 'author',
    data: {
      ref: 'pi_0',
      kind: 'subtask',
      title: 'First leaf',
    },
  },
  {
    event: 'author',
    data: {
      ref: 'pi_1',
      kind: 'subtask',
      title: 'Second leaf',
    },
  },
  {
    event: 'author',
    data: {
      ref: 'pi_2',
      kind: 'subtask',
      title: 'Third leaf',
    },
  },
  {
    event: 'lessons_injected',
    data: {
      phase: 'regular_planning',
      cardPhase: 'author',
      cardRef: 'pi_0',
      lessonIds: [],
      count: 0,
    },
  },
  {
    event: 'lessons_injected',
    data: {
      phase: 'regular_planning',
      cardPhase: 'author',
      cardRef: 'pi_1',
      lessonIds: [],
      count: 0,
    },
  },
  {
    event: 'lessons_injected',
    data: {
      phase: 'regular_planning',
      cardPhase: 'author',
      cardRef: 'pi_2',
      lessonIds: [],
      count: 0,
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '27f4825c-f95c-4844-8d6e-de01b1c48132',
      tool: 'get_item',
      family: 'plan_tree',
      verb: 'look_up',
      object: {
        kind: 'item',
        value: 'MOTIR-42',
      },
      itemRef: 'First leaf',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '47c4601c-37a0-4908-a8b9-ab11bbae0cd2',
      tool: 'get_item',
      family: 'plan_tree',
      verb: 'look_up',
      object: {
        kind: 'item',
        value: 'MOTIR-42',
      },
      itemRef: 'Second leaf',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '1f6b96bf-2f39-4590-9179-19601708755f',
      tool: 'get_item',
      family: 'plan_tree',
      verb: 'look_up',
      object: {
        kind: 'item',
        value: 'MOTIR-42',
      },
      itemRef: 'Third leaf',
    },
  },
  {
    event: 'retrieval',
    data: {
      tool: 'get_item',
      family: 'plan_tree',
      ok: true,
      args: {
        key: 'MOTIR-42',
      },
      callId: '27f4825c-f95c-4844-8d6e-de01b1c48132',
    },
  },
  {
    event: 'retrieval',
    data: {
      tool: 'get_item',
      family: 'plan_tree',
      ok: true,
      args: {
        key: 'MOTIR-42',
      },
      callId: '47c4601c-37a0-4908-a8b9-ab11bbae0cd2',
    },
  },
  {
    event: 'retrieval',
    data: {
      tool: 'get_item',
      family: 'plan_tree',
      ok: true,
      args: {
        key: 'MOTIR-42',
      },
      callId: '1f6b96bf-2f39-4590-9179-19601708755f',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '9fff7656-78cf-46f6-999d-25646b9f1cbf',
      tool: 'update_item',
      family: 'item',
      verb: 'update',
      object: {
        kind: 'item',
        value: 'First leaf',
      },
      itemRef: 'First leaf',
    },
  },
  {
    event: 'tool_call_failed',
    data: {
      callId: '9fff7656-78cf-46f6-999d-25646b9f1cbf',
      reason: 'refused',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: 'e992dd7e-6d5c-4a09-bcd6-0ec2d88b7fca',
      tool: 'author',
      family: 'author',
      verb: 'write',
      object: {
        kind: 'item',
        value: 'First leaf',
      },
      itemRef: 'First leaf',
    },
  },
  {
    event: 'status',
    data: {
      phase: 'author_ended',
      ref: 'pi_0',
      outcome: 'authored',
      attempts: 1,
      startedAt: '2026-10-09T12:57:25.910Z',
      endedAt: '2026-10-09T12:57:25.914Z',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: 'bd45f89f-3bbf-4734-8055-03252b1b86a6',
      tool: 'author',
      family: 'author',
      verb: 'write',
      object: {
        kind: 'item',
        value: 'Second leaf',
      },
      itemRef: 'Second leaf',
    },
  },
  {
    event: 'status',
    data: {
      phase: 'author_ended',
      ref: 'pi_1',
      outcome: 'authored',
      attempts: 1,
      startedAt: '2026-10-09T12:57:25.910Z',
      endedAt: '2026-10-09T12:57:25.916Z',
    },
  },
  {
    event: 'tool_call',
    data: {
      callId: '017ce0f8-8504-477c-b95c-cfab9107c66f',
      tool: 'author',
      family: 'author',
      verb: 'write',
      object: {
        kind: 'item',
        value: 'Third leaf',
      },
      itemRef: 'Third leaf',
    },
  },
  {
    event: 'status',
    data: {
      phase: 'author_ended',
      ref: 'pi_2',
      outcome: 'authored',
      attempts: 1,
      startedAt: '2026-10-09T12:57:25.910Z',
      endedAt: '2026-10-09T12:57:25.916Z',
    },
  },
  {
    event: 'pass',
    data: {
      pass: 1,
      proposed: 3,
      deepened: 3,
      modified: 0,
      removed: 0,
    },
  },
  {
    event: 'turn',
    data: {
      action: 'draft',
      message: 'Searched the neighbourhood — nothing existing matches. Nothing covers it.',
      outcome: 'nothing_matches',
      matchedKeys: [],
    },
  },
  {
    event: 'planned',
    data: {
      proposed: 3,
      deepened: 3,
      modified: 0,
      removed: 0,
    },
  },
  {
    event: 'validated',
    data: {
      planId: 'plan_s',
      valid: true,
    },
  },
];
