// ⚠️ GENERATED — DO NOT EDIT. Run `pnpm generate:mcp-tool-schemas`.
//
// Every MCP tool's `inputSchema`, exactly as `tools/list` serves it
// (Story MOTIR-3875 · Subtask MOTIR-4389). Written by
// `scripts/generateMcpToolSchemas.ts` from a live handshake against
// `buildMcpServer`, and pinned byte-for-byte against a fresh one by
// `tests/mcp/tool-schema-truth.test.ts` — so this file cannot drift from the
// server, and a hand edit is red rather than published.
//
// ── Why the schemas are copied HERE at all ──────────────────────────────────
// `lib/apiDocs/mcp.ts` is a LEAF: it imports `lib/mcp/toolPermissions.ts` and
// nothing else from `lib/mcp/`, so that the anonymous
// `GET /api/docs/mcp-tools.json` handler does not pull the tool registry, the
// services and Prisma behind it. The schemas live inside `registerTool(...)`
// calls that only the registry can reach. This module is the seam: a value the
// registry produced, in a file that imports nothing at runtime.
//
// The map is TOTAL over the tool set by TYPE — a tool added to the registry
// forces a `TOOL_PERMISSIONS` entry, which makes this annotation incomplete and
// this file a compile error until it is regenerated.

import type { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import type { McpToolInputSchema } from './mcpToolSchema';

/** Tool name → the draft-07 JSON Schema of its arguments. */
export const MCP_TOOL_INPUT_SCHEMAS: Record<keyof typeof TOOL_PERMISSIONS, McpToolInputSchema> = {
  add_comment: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      body: {
        type: 'string',
        minLength: 1,
        description: 'The comment body (Markdown). Mention a member with @[name](userId).',
      },
    },
    required: ['key', 'body'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  add_lesson: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      title: {
        type: 'string',
        minLength: 1,
        description:
          'The takeaway, in one line — the thing a planner should do differently, not a headline for an incident. "Pin the target repository on every card that ships code" is a lesson; "Repository problems in the billing epic" is a label for one.',
      },
      body: {
        type: 'string',
        minLength: 1,
        description:
          'What goes wrong, stated so it is recognisable the NEXT time rather than recounted from the last. Describe the situation and the failure, not the specific work items it happened to involve.',
      },
      why: {
        type: 'string',
        minLength: 1,
        description:
          'Why it matters — the cost of getting it wrong. This is the one field that may carry the specifics of your own case (what it cost, when, on which work), because it is what justifies the rule rather than what a future plan is matched against.',
      },
      howToApply: {
        type: 'string',
        minLength: 1,
        description:
          'The actionable rule, addressed to a future planner in the second person: "Before sealing a card that ships code, set its target repository." Not a restatement of the body — if this field reads like the body, the lesson has no rule in it.',
      },
      mistakeType: {
        type: 'string',
        enum: ['onboarding_planning', 'regular_planning', 'planning_craft'],
        default: 'regular_planning',
        description:
          'Which kind of planning this lesson is for: "regular_planning" (planning an existing project — the usual answer), "onboarding_planning" (drafting a project\'s first tree), or "planning_craft" (how to plan well, whatever is being planned).',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['epic', 'story', 'task', 'bug', 'subtask'] },
        description:
          'WHICH WORK-ITEM KINDS this lesson is about, and one of the three axes that decide when a future plan is shown it. LEAVING IT OUT MEANS "every kind" — occasionally right, and usually the reason a lesson turns up in plans it has nothing to do with. Say what you mean on each axis rather than skipping it.',
      },
      types: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
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
          ],
        },
        description:
          'WHICH WORK TYPES this lesson is about (code, design, test, …). Leaving it out means "every type". Under-claiming is as wrong as over-claiming: a lesson typed only "code" stops reaching the chore work it also applies to.',
      },
      phases: {
        type: 'array',
        items: { type: 'string', enum: ['skeleton', 'deepen'] },
        description:
          'WHICH PLANNING PHASE this lesson is about: "skeleton" (laying out titles and dependencies) or "deepen" (writing a card\'s body). Leaving it out means both.',
      },
      sourceRef: {
        type: 'string',
        description:
          'Where this lesson came from — a work-item key, a runbook name, a ticket. Also the idempotency key: adding the same lesson again with the same sourceRef returns the existing one instead of a duplicate.',
      },
    },
    required: ['projectKey', 'title', 'body', 'why', 'howToApply'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  add_plan_items: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['add', 'modify', 'remove'],
              description: 'add a new item, modify one, or remove one.',
            },
            workItemId: {
              type: 'string',
              description: '`modify` / `remove` only: the existing target work item’s id.',
            },
            proposedFields: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  minLength: 1,
                  description: 'The proposed item’s title. Required on an `add`.',
                },
                kind: {
                  type: 'string',
                  enum: ['epic', 'story', 'task', 'bug', 'subtask'],
                  description:
                    'The proposed kind. Defaults to `task` (a standalone leaf) when omitted.',
                },
                descriptionMd: { type: 'string', description: 'Markdown body — WHAT to do.' },
                explanationMd: { type: 'string', description: 'Markdown body — WHY it matters.' },
                type: {
                  type: 'string',
                  enum: [
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
                  ],
                  description:
                    'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum, so anything else is refused here rather than 500ing at approve.',
                },
                priority: { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
                executor: { type: 'string', enum: ['coding_agent', 'human'] },
                storyPoints: {
                  type: 'number',
                  description:
                    'Agile sizing. Validated at the boundary exactly as the create path validates it.',
                },
                estimateMinutes: { type: 'integer', description: 'Estimated minutes of work.' },
                targetRepo: {
                  type: 'string',
                  description:
                    'WHICH REPO the item ships in — validated against the project’s set at approve.',
                },
                targetRepoRole: {
                  type: 'string',
                  description: 'The PORTABLE repo pin — a role of the project’s repository set.',
                },
                todos: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      text: {
                        type: 'string',
                        description:
                          'WHAT to do — ONE operation, at most 200 characters. "Change this one setting", "run this one command". Navigation is NOT an operation: "go to the dashboard and find the panel" belongs in `notesMd` of the row that then changes something.',
                      },
                      notesMd: {
                        type: ['string', 'null'],
                        description:
                          'The INSTRUCTIONS for this one operation — Markdown, at most 2000 characters. The HOW, where `text` is the WHAT.',
                      },
                      commandText: {
                        type: ['string', 'null'],
                        description:
                          'The command this step runs, if it runs one — at most 500 characters, and in this field rather than inside `text`, because this is what the reader copies.',
                      },
                      executor: {
                        anyOf: [
                          { type: 'string', enum: ['coding_agent', 'human'] },
                          { type: 'null' },
                        ],
                        description:
                          'Who this STEP is for, when it differs from the card’s. Omit it and the row inherits the proposal’s own `executor` at approve, falling back to `human`.',
                      },
                    },
                    required: ['text'],
                    additionalProperties: false,
                  },
                  description:
                    'The card’s ORDERED STEPS, written as its to-do list. ARRAY ORDER IS LIST ORDER — the sequence they are performed in — and approving the plan writes one real to-do row per element, none ticked. A `manual` card’s steps belong HERE, not only in the description: the reviewer reads the list they will tick before they approve it, and the created card carries it from birth. Leaf kinds only — a container’s steps are its children.',
                },
              },
              required: ['title'],
              additionalProperties: false,
              description: 'The proposed item’s fields. Required on an `add`, ignored otherwise.',
            },
            patch: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Re-title the target.' },
                descriptionMd: {
                  type: ['string', 'null'],
                  description: 'Markdown body — WHAT to do. An explicit `null` clears it.',
                },
                explanationMd: {
                  type: ['string', 'null'],
                  description:
                    'Markdown body — WHY it matters. An explicit `null` clears it. Patch it whenever a re-scope moves the card’s rationale: a survivor keeps its OLD explanation unless you rewrite it, and a stale WHY is worse than a null one.',
                },
                priority: {
                  anyOf: [
                    { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
                    { type: 'null' },
                  ],
                },
                type: {
                  anyOf: [
                    {
                      type: 'string',
                      enum: [
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
                      ],
                    },
                    { type: 'null' },
                  ],
                  description:
                    'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum. An explicit `null` clears it.',
                },
                storyPoints: {
                  type: ['number', 'null'],
                  description: 'Re-scope the agile sizing. An explicit `null` clears it.',
                },
                estimateMinutes: {
                  anyOf: [{ type: 'integer' }, { type: 'null' }],
                  description: 'Re-scope the time estimate. An explicit `null` clears it.',
                },
                targetRepo: {
                  type: ['string', 'null'],
                  description: 'RE-PIN which repo the item ships in. An explicit `null` unpins it.',
                },
                targetRepoRole: {
                  type: ['string', 'null'],
                  description: 'RE-PIN the portable repo role. An explicit `null` unpins it.',
                },
                parentRef: {
                  type: ['string', 'null'],
                  description:
                    'RE-PARENT the target: a work-item KEY ("ACME-7") or a real work-item id — the card this one should hang under instead. An explicit `null` moves it to the PROJECT ROOT. Omit the key to leave the parent where it is. ⚠️ It must name a work item that ALREADY EXISTS — a `planItem:<id>` ref is refused, because every check a re-parent owes (the kind-parent matrix, same-project, no cycle, the depth cap, and a refusal to hang new work under a FINISHED parent) is a question about a live row. To land a card under one this plan is adding, `add` it with that `parentRef` instead.',
                },
                blockedByAdd: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Dependency edges to ADD — work-item keys ("ACME-7"), real work-item ids, or `planItem:<id>` refs.',
                },
                blockedByRemove: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Dependency edges to REMOVE — work-item keys ("ACME-7"), real work-item ids, or `planItem:<id>` refs.',
                },
              },
              additionalProperties: true,
              description:
                '`modify` only: the SPARSE patch to apply to the target at approve. A key you omit is left untouched; an explicit `null` CLEARS a nullable field. Nothing is applied until someone approves the plan in Motir.',
            },
            parentRef: {
              type: 'string',
              description:
                'Where the proposed item hangs, in any of THREE forms: a work-item KEY ("ACME-7", the identifier every other tool takes, case-insensitive); a real work-item id; or `planItem:<id>` naming another `add` in THIS plan — an id this tool returned in `planItemIds` on an earlier call. A key is resolved to its id when the proposal is appended, so the three are interchangeable; a key that names no work item in this workspace is refused HERE, not at approve.',
            },
            blockedByRefs: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Dependency edges, in the same three forms as `parentRef`: work-item keys ("ACME-7"), real work-item ids, or `planItem:<id>` refs into this plan.',
            },
            baseRevision: {
              type: 'string',
              description:
                '`modify` / `remove` only: the target revision the change was computed against.',
            },
          },
          required: ['op'],
          additionalProperties: false,
        },
        description:
          'The batch to append, in the order you want their ids back. MAY be empty — but ONLY together with `final: true`, which is how a titles-first pass CLOSES a plan it has finished writing.',
      },
      final: {
        type: 'boolean',
        description:
          'Set true on the LAST batch to close the plan (`generating` → `planned`), which is what puts it in front of a person for review. After that, an append needs `revision: true`. Send it with an EMPTY `proposals` array to close a plan you have nothing left to append to.',
      },
      revision: {
        type: 'boolean',
        description:
          'Set true to append to a plan you have ALREADY closed — a plan that is `planned` and in the review queue. Without it such an append is refused. The plan does NOT re-open: it is `planned` before, during and after, and the append is recorded on its timeline with the harness and model that made it, so the reviewer can see a card arrived after they started reading. It cannot be combined with `final` (the plan is already closed) and requires at least one proposal (there is nothing else it could mean). On a `generating` plan it is unnecessary and simply does nothing. `approved` and `declined` stay frozen.',
      },
    },
    required: ['planId', 'proposals'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  append_plan_turn: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      targetKeys: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: 20,
        description:
          'Optional work-item identifiers (e.g. ["ACME-7", "ACME-9"], case-insensitive) to ANCHOR the conversation at. Omit for the project-wide planning thread. The anchor SET is the thread\'s identity — order and duplicates do not matter, and the same set always resumes the same conversation.',
      },
      body: {
        type: 'string',
        minLength: 1,
        description: 'What to say in this turn — what you want changed about the plan.',
      },
    },
    required: ['projectKey', 'body'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  archive_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  attach_file: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      filename: {
        type: 'string',
        minLength: 1,
        description: 'The file name as a reader should see it, e.g. "findings.md" or "triage.png".',
      },
      contentType: {
        type: 'string',
        minLength: 1,
        description:
          'The file’s media type, e.g. "image/png" or "text/markdown". Must be on the upload allowlist; "text/html" is deliberately refused (415) — an HTML design mock has its own publisher.',
      },
      contentBase64: {
        type: 'string',
        minLength: 1,
        description: 'The file’s bytes, base64-encoded.',
      },
    },
    required: ['key', 'filename', 'contentType', 'contentBase64'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  change_kind: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      kind: {
        type: 'string',
        enum: ['story', 'task', 'bug', 'subtask'],
        description:
          "The new work item kind. Must keep the kind-parent matrix legal for both the item's current parent AND all of its children. (This is the hierarchy KIND, NOT the work type — use update_work_item to change type/executor.)",
      },
    },
    required: ['key', 'kind'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  claim_next_ready: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  claim_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  complete_session: {
    type: 'object',
    properties: {
      sessionBranch: {
        type: 'string',
        minLength: 1,
        description: 'The session/integration branch name, e.g. "session/ACME-42-run".',
      },
      implementationSource: {
        type: 'string',
        enum: ['byok', 'manual'],
        description:
          'Optional self-reported implementation source: "byok" (an agent on your own machine) or "manual" (a human, no agent). Defaults to "byok" when a harness/model is reported. "hosted" is not accepted here (that is trusted/metered).',
      },
      implementationHarness: {
        type: 'string',
        description:
          'Optional self-reported implementation harness (e.g. "opencode", "Claude Code").',
      },
      implementationModel: {
        type: 'string',
        description: 'Optional self-reported implementation model (e.g. "claude", "deepseek").',
      },
    },
    required: ['sessionBranch'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  complete_sprint: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        minLength: 1,
        description: 'The sprint id (as returned by `list_sprints`).',
      },
      carryOverTo: {
        anyOf: [
          { type: 'string', const: 'backlog' },
          {
            type: 'object',
            properties: { sprintId: { type: 'string', minLength: 1 } },
            required: ['sprintId'],
            additionalProperties: false,
          },
        ],
        description:
          'REQUIRED disposition for unfinished items: "backlog" (move them to the backlog) or { "sprintId": "<id>" } to move them into another PLANNED sprint in the same project. Done items always stay on the completed sprint.',
      },
    },
    required: ['sprintId', 'carryOverTo'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_acceptance_upload: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      hasTrace: {
        type: 'boolean',
        description:
          'True to ALSO mint a grant for the Playwright trace (a dev diagnostic beside the video). Defaults to false — mint it only if you actually captured one.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_design_upload: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['mock', 'image', 'note_file'],
              description:
                'What this file IS: "mock" for the `*.mock.html`, "image" for the `.png` export, "note_file" for the complete `design-notes.md` text.',
            },
            sourcePath: {
              type: 'string',
              minLength: 1,
              description:
                'The path the file has IN THE REPOSITORY, e.g. "design/ai-chat/planning-workspace.png". Its basename is carried into the minted key, so a grant stays recognisable.',
            },
            contentType: {
              type: 'string',
              minLength: 1,
              description:
                'The media type you will PUT — "text/html", "image/png" or "text/markdown". The grant is BOUND to it: a PUT sending anything else is refused by the store.',
            },
          },
          required: ['kind', 'sourcePath', 'contentType'],
          additionalProperties: false,
        },
        minItems: 1,
        description:
          'The files you are about to upload — one grant is minted per entry, in this order.',
      },
      withinParentKey: {
        type: 'string',
        description:
          'On a PARENT-RUN publish only: the container whose branch this belongs to. It asserts the target is one of that container’s children, and is not stored.',
      },
    },
    required: ['key', 'files'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_plan: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      title: {
        type: 'string',
        minLength: 1,
        description: 'Optional short label for the plan — what it is proposing, in a line.',
      },
      summary: {
        type: 'string',
        minLength: 1,
        description:
          'Optional longer summary (Markdown) of what this plan proposes and why, shown to the reviewer above the tree. Not write-once: `update_plan` corrects it — and the title — after the fact, on a `generating` or `planned` plan, without touching a proposal.',
      },
      plannedWithHarness: {
        type: 'string',
        minLength: 1,
        description:
          'Optional: the harness/tool you are running as (e.g. "Claude Code", "Codex"). Shown to the person reviewing this plan, so they can see it was written by an agent rather than generated by Motir.',
      },
      plannedWithModel: {
        type: 'string',
        minLength: 1,
        description:
          'Optional: the model you are running (e.g. "claude-opus-5"). Shown beside the harness.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_sprint: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      name: {
        type: 'string',
        description: 'Optional sprint name; defaults to "Sprint <n>" (the next sequence).',
      },
      goal: { type: 'string', description: 'Optional sprint goal.' },
      startDate: {
        type: 'string',
        description:
          'Optional planned start (ISO-8601). A planned sprint activates on start_sprint.',
      },
      endDate: {
        type: 'string',
        description: 'Optional planned end (ISO-8601); must be ≥ startDate.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  create_work_item: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the item is created in — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      kind: {
        type: 'string',
        enum: ['epic', 'story', 'task', 'bug', 'subtask'],
        description:
          'The work item kind. Use "epic" (no parentKey) to create a top-level capability area; "bug" under a story/epic to log a defect (the bug-logging protocol).',
      },
      title: { type: 'string', minLength: 1, description: 'The work item title (one line).' },
      parentKey: {
        type: 'string',
        description:
          'Optional parent work item identifier (e.g. "ACME-3") — must be a kind-legal, same-project parent.',
      },
      descriptionMd: { type: 'string', description: 'Optional Markdown description body.' },
      priority: {
        type: 'string',
        enum: ['lowest', 'low', 'medium', 'high', 'highest'],
        description: 'Optional priority (lowest…highest); omit for the project default.',
      },
      storyPoints: {
        anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
        description:
          'Optional story-point estimate (the agile sizing number, distinct from a time estimate). A non-negative number ≤ 9999.99 with at most two decimal places; omit (or null) to leave it unestimated.',
      },
      estimateMinutes: {
        anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
        description:
          'Optional estimated minutes of work (the TIME estimate, distinct from story points); omit (or null) to leave it unestimated.',
      },
      type: {
        anyOf: [
          {
            type: 'string',
            enum: [
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
            ],
          },
          { type: 'null' },
        ],
        description:
          'Optional work type (code, design, test, …) — leaf items (task / bug / subtask) only; rejected on a story. Setting a type seeds the executor from the type default unless an explicit executor is also given. Omit (or null) to leave it untyped.',
      },
      executor: {
        anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
        description:
          'Optional executor ("coding_agent" or "human") — leaf items only; overrides the type default when supplied. Omit (or null) to take the type default (or leave it unset when no type is given).',
      },
      targetRepo: {
        type: ['string', 'null'],
        description:
          'Optional: WHICH REPO this item ships in — the bare repo name (e.g. "motir-core") or the "owner/name" form. Must name one of the workspace\'s CONNECTED repositories; an unknown name is rejected. This is what routes the CLI to the right checkout at dispatch (one subtask = one repo = one PR). Omit (or null) to leave it unpinned — dispatch then falls back to the workspace\'s single connected repo, or reports no repo when ambiguous.',
      },
      targetRepos: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional: EVERY repository this item ships in, ORDERED — bare repo names (e.g. ["motir-core", "motir-ai"]) or the "owner/name" form. The FIRST element is the PRIMARY: the one dispatch routes the CLI to. The rest record where the item\'s other work lands, and the item does not complete until EVERY repository on the list has a pull request merged onto that repository\'s own default branch. Each element is validated against the project\'s repository domain; duplicates collapse, blank elements are dropped, and one unknown element rejects the whole write. Use it for a card that legitimately spans repositories — ONE SUBTASK is still ONE REPO, so this is for a story or a task, not a subtask. `[]` is the empty set. MUTUALLY EXCLUSIVE with targetRepo, which IS this list\'s first element: supplying both is rejected rather than silently resolved.',
      },
      targetRepositories: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Optional: EVERY repository this item ships in, as REFERENCES to the project's repository ROWS — their ids, ORDERED, the FIRST being the PRIMARY the CLI is dispatched into. Prefer this over targetRepos when you have the ids: a reference survives the repository being renamed, and it can name one of two rows that share a role, which a name cannot. The names you read back are what these resolve to. An id outside THIS item's project is rejected (the error lists the project's rows as \"id (name)\"); duplicates collapse; `[]` is the empty set. MUTUALLY EXCLUSIVE with BOTH targetRepo and targetRepos — they are the same field in three forms, so supplying two is rejected rather than silently resolved.",
      },
      plannedWithHarness: {
        type: 'string',
        description:
          'Optional: the harness/tool this item was planned with (e.g. "Claude Code", "Codex"). Recorded as self-reported planning provenance alongside the server-set source "mcp"; omit to leave it unrecorded.',
      },
      plannedWithModel: {
        type: 'string',
        description:
          'Optional: the LLM this item was planned with (e.g. "claude-opus-4-8", "deepseek-chat"). Recorded as self-reported planning provenance; omit to leave it unrecorded.',
      },
    },
    required: ['projectKey', 'kind', 'title'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  delete_sprint: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        minLength: 1,
        description: 'The sprint id (as returned by `list_sprints`).',
      },
    },
    required: ['sprintId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  delete_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  dispatch_prompt: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      sessionBranch: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._\\-/]*$',
        description:
          'Optional session branch to FALL BACK to when this item carries no lineage of its own — the unattended-run seed (`motir auto`). It never overrides: an item whose dependencies are already integrated, or that is itself integrated, keeps that branch, so a caller cannot redirect a live lineage.',
      },
      findingsPolicy: {
        type: 'string',
        description:
          'Optional comma-separated list of the capabilities this run switches OFF for the agent — one or more of: log-bug, replan. Omitted renders the COMPLETE outcome protocol, which is what every caller wanting to read the real contract should do. An unrecognised capability is refused, never ignored.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  expand_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_plan: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        minLength: 1,
        description:
          'The plan id — as returned by an `expand_item` submit, by `get_plan_status`, or shown on the plan in Motir.',
      },
    },
    required: ['planId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_plan_status: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        minLength: 1,
        description: 'The plan id an `expand_item` submit returned. Pass this OR `jobId`.',
      },
      jobId: {
        type: 'string',
        minLength: 1,
        description: 'The job id an `expand_item` submit returned. Pass this OR `planId`.',
      },
    },
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_project_state: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"), case-insensitive. With `planId`, this may instead be a `planItem:<id>` temp-ref naming an `add` in that plan (case-SENSITIVE, as `add_plan_items` returned it).',
      },
      planId: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL — the id of a plan (as returned by `create_plan`) to PROJECT over. When given, the answer is computed over the project’s live tree ⊕ that plan’s proposals, so an agent can check the tree it is proposing BEFORE anyone reviews it. Omit it for the committed tree — a call without this argument behaves exactly as it did before projection existed. Nothing is created, mutated or persisted either way, and a proposal never becomes a work item except by approving the plan in Motir.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  get_work_item_activity: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      view: {
        type: 'string',
        enum: ['all', 'comments', 'history'],
        description:
          'Which stream to read: "all" (default) — comments and history interleaved in timestamp order; "comments" — comment threads with their replies; "history" — the change trail only.',
      },
      cursor: {
        type: 'string',
        description:
          "Opaque continuation token from a previous call's nextCursor. Echo it back verbatim; never construct or parse one.",
      },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description:
          'Page-walk direction. Omit for each view\'s shipped default ("desc" — newest first — for "all" and "history"; "asc" for "comments", the Jira default sort).',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  link_pull_request: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      repository: {
        type: 'string',
        description:
          'The repository as "owner/name", exactly as it is connected in Motir (case-insensitive). Give this WITH `number`, or give `url` instead — not neither.',
      },
      number: {
        type: 'integer',
        exclusiveMinimum: 0,
        description: 'The pull-request number, e.g. 2291. Give this with `repository`.',
      },
      url: {
        type: 'string',
        description:
          'The full pull-request URL, e.g. "https://github.com/acme/web/pull/2291" — the line `gh pr create` prints, so it can be passed through verbatim. An alternative to `repository` + `number`, never a supplement: if both are given they must agree.',
      },
      headRef: {
        type: 'string',
        minLength: 1,
        description:
          'The branch the pull request is FROM, e.g. "subtask/ACME-7-widget". Used only when no webhook delivery has arrived yet and this call is what creates the row; once a delivery has landed, the delivery is authoritative and this is ignored.',
      },
      baseRef: {
        type: 'string',
        minLength: 1,
        description:
          'The branch the pull request TARGETS, e.g. "main". Same rule as `headRef`: it seeds the row when there is none, and a later delivery overwrites it.',
      },
      title: {
        type: 'string',
        description:
          'The pull request’s title, for the row this call may have to create. Optional — the first webhook delivery supplies the real one either way.',
      },
    },
    required: ['key', 'headRef', 'baseRef'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  link_work_items: {
    type: 'object',
    properties: {
      fromKey: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      toKey: { $ref: '#/properties/fromKey' },
      relationship: {
        type: 'string',
        enum: ['blocked_by', 'blocks', 'relates_to', 'duplicates', 'clones'],
        description:
          'The relationship FROM the first item TO the second, read "fromKey <relationship> toKey": "blocked_by" (fromKey is blocked by toKey — the dependency edge that holds fromKey out of the ready set), "blocks" (the inverse — fromKey blocks toKey), "relates_to", "duplicates", or "clones".',
      },
    },
    required: ['fromKey', 'toKey', 'relationship'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  list_projects: {
    type: 'object',
    properties: {},
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  list_ready: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['epic', 'story', 'task', 'bug', 'subtask'] },
        description: 'Restrict to these work item kinds; omit for any.',
      },
      priority: {
        type: 'array',
        items: { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
        description: 'Restrict to these priorities; omit for any.',
      },
      assigneeId: {
        type: ['string', 'null'],
        description:
          'A user id to filter by; null or "unassigned" for the unassigned bucket; omit for any.',
      },
      cursor: {
        type: 'string',
        description: 'Opaque page cursor from a previous call’s nextCursor.',
      },
      limit: {
        type: 'integer',
        exclusiveMinimum: 0,
        maximum: 200,
        description: 'Page size (1–200, default 50).',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  list_sprints: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  mark_integrated: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      sessionBranch: {
        type: 'string',
        minLength: 1,
        description: 'The session/integration branch name, e.g. "session/ACME-42-run".',
      },
      implementationSource: {
        type: 'string',
        enum: ['byok', 'manual'],
        description:
          'Optional self-reported implementation source: "byok" (an agent on your own machine) or "manual" (a human, no agent). Defaults to "byok" when a harness/model is reported. "hosted" is not accepted here (that is trusted/metered).',
      },
      implementationHarness: {
        type: 'string',
        description:
          'Optional self-reported implementation harness (e.g. "opencode", "Claude Code").',
      },
      implementationModel: {
        type: 'string',
        description: 'Optional self-reported implementation model (e.g. "claude", "deepseek").',
      },
    },
    required: ['key', 'sessionBranch'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  move_to_backlog: {
    type: 'object',
    properties: {
      keys: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description: 'Work item identifiers to move to the backlog, e.g. ["ACME-7", "ACME-8"].',
      },
    },
    required: ['keys'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  move_to_parent: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      parentKey: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
        description:
          'The NEW parent work item identifier (e.g. "ACME-3") — must be a kind-legal, same-project parent, and may not be the item itself or one of its descendants. Pass null to promote the item to a top-level root (allowed only for kinds that may live at the top level).',
      },
    },
    required: ['key', 'parentKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  move_to_sprint: {
    type: 'object',
    properties: {
      keys: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description: 'Work item identifiers to move, e.g. ["ACME-7", "ACME-8"].',
      },
      sprintId: {
        type: 'string',
        minLength: 1,
        description: 'The sprint id (as returned by `list_sprints`).',
      },
    },
    required: ['keys', 'sprintId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  next_ready: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['epic', 'story', 'task', 'bug', 'subtask'] },
        description: 'Restrict to these work item kinds; omit for any.',
      },
      priority: {
        type: 'array',
        items: { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
        description: 'Restrict to these priorities; omit for any.',
      },
      assigneeId: {
        type: ['string', 'null'],
        description:
          'A user id to filter by; null or "unassigned" for the unassigned bucket; omit for any.',
      },
      excludeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Work item ids already dispatched this loop — skip them.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  open_plan_session: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      targetKeys: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: 20,
        description:
          'Optional work-item identifiers (e.g. ["ACME-7", "ACME-9"], case-insensitive) to ANCHOR the conversation at. Omit for the project-wide planning thread. The anchor SET is the thread\'s identity — order and duplicates do not matter, and the same set always resumes the same conversation.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  publish_acceptance_result: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      videoPathname: {
        type: 'string',
        minLength: 1,
        description:
          'The `pathname` of the video grant you uploaded to, exactly as it was returned.',
      },
      tracePathname: {
        type: 'string',
        description: 'The trace grant’s `pathname`, when one was minted and uploaded to.',
      },
      chapters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              minLength: 1,
              description:
                'The step this marker jumps to, in the reviewer’s words (e.g. "Open the item").',
            },
            tSeconds: {
              type: 'number',
              minimum: 0,
              description: 'Offset into the recording, in seconds, where that step begins.',
            },
          },
          required: ['label', 'tSeconds'],
          additionalProperties: false,
        },
        description:
          'The chapter markers, from the run’s `chapters.json` — what the reviewer scrubs by. A receipt with none is watchable but not navigable, so send them when the spec wrote them.',
      },
      commitSha: {
        type: 'string',
        description:
          'The commit the run recorded at. ALSO THE IDEMPOTENCY KEY: re-publishing the same commit + producedByKey returns the existing receipt instead of superseding it.',
      },
      producedByKey: {
        type: 'string',
        description: 'The E2E work item that produced the recording, e.g. "ACME-7".',
      },
    },
    required: ['key', 'videoPathname'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  publish_design_result: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      assets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['mock', 'image', 'note_file'],
              description:
                'What this file IS: "mock" for the `*.mock.html`, "image" for the `.png` export, "note_file" for the complete `design-notes.md` text.',
            },
            sourcePath: {
              type: 'string',
              minLength: 1,
              description:
                'The path the file has IN THE REPOSITORY, e.g. "design/work-items/detail.png". The repository stays the source of truth; this records where the published copy came from.',
            },
            contentType: {
              type: 'string',
              minLength: 1,
              description:
                'The file’s media type — "text/html", "image/png" or "text/markdown". Anything else is refused: this is the ONE path on which "text/html" is accepted at all. Required with `contentBase64`; omit it with `pathname`, where the STORE’s own answer is authoritative.',
            },
            contentBase64: {
              type: 'string',
              minLength: 1,
              description:
                'The file’s bytes, base64-encoded — the INLINE path, for a small asset. Send this OR `pathname`, never both and never neither.',
            },
            pathname: {
              type: 'string',
              minLength: 1,
              description:
                'The `pathname` of a `create_design_upload` grant you have already PUT this file to — the path for an asset too large to travel as a tool argument. Send this OR `contentBase64`.',
            },
          },
          required: ['kind', 'sourcePath'],
          additionalProperties: false,
        },
        minItems: 1,
        description:
          'The files to publish — normally three: the mock, the `.png`, and the note as a "note_file". At least one is required. Each entry carries EITHER `contentBase64` (the bytes inline, for a small asset) OR the `pathname` of a `create_design_upload` grant you have already PUT to. One publish uses one of the two forms for ALL its assets.',
      },
      noteMd: {
        type: 'string',
        description:
          'The SECTIONS of the design note this work CHANGED, as Markdown — not the whole file. You wrote them, so you know which they are; a whole area note runs to hundreds of kilobytes and is not what a reviewer wants to read. Over 64 KiB it is truncated at a "##" boundary for display, and the complete text still ships as the "note_file" asset.',
      },
      commitSha: {
        type: 'string',
        description: 'The commit the assets were published from. Also the idempotency key.',
      },
      producedByKey: {
        type: 'string',
        description: 'The work item whose pull request produced this result, e.g. "ACME-7".',
      },
      withinParentKey: {
        type: 'string',
        description:
          'On a PARENT-RUN publish only: the container whose branch this belongs to. It asserts the target is one of that container’s children, and is not stored.',
      },
    },
    required: ['key', 'assets'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  reinforce_lesson: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      lessonId: {
        type: 'string',
        minLength: 1,
        description:
          'The lesson this occurrence matched — the `id` `search_lessons` returns for each ranked row. Take it from that result; do not construct one.',
      },
      occurrenceRef: {
        type: 'string',
        minLength: 1,
        description:
          'YOUR identifier for the EVENT that just happened — the work item you are running (`MOTIR-123`), or the bug you filed for it. It is what makes this idempotent: the same event recorded twice counts once. It names the occurrence, NOT the lesson.',
      },
    },
    required: ['projectKey', 'lessonId', 'occurrenceRef'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  search_lessons: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      query: {
        type: 'string',
        minLength: 1,
        description:
          'Your question, in TAKEAWAY register — the action you are about to take and the SHAPE of what could go wrong, in the words a lesson would be written in: "counting a population from a working tree instead of a ref". NOT the card\'s title ("board filter at scale"), which queries the wrong register and ranks by accident. This text is what decides which lessons arrive, so it is worth a sentence rather than a phrase. A card with more than one distinct risk deserves more than one search: one call returns a handful, and one query cannot rank for three different failure shapes.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['epic', 'story', 'task', 'bug', 'subtask'] },
        description:
          'The work-item KIND(s) this search is about. Omitting it leaves the axis UNCONSTRAINED, which is often right — a lesson tagged with no kind reaches every query either way.',
      },
      types: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
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
          ],
        },
        description:
          'The work TYPE(s) this search is about (code, design, test, …). Omitting it leaves the axis unconstrained.',
      },
      phases: {
        type: 'array',
        items: { type: 'string', enum: ['skeleton', 'deepen'] },
        description:
          'Which part of a card you are writing: "skeleton" (laying out a level\'s children — shape, edges, coverage) or "deepen" (writing a body — criteria, sizing, claims). The coordinate only you can supply.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'How many lessons to return, nearest first. Default 8.',
      },
    },
    required: ['projectKey', 'query'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  search_work_items: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      filter: {
        type: 'object',
        properties: {
          version: {
            type: 'string',
            description: 'Envelope version — must be "v1" (the only supported version).',
          },
          combinator: {
            type: 'string',
            enum: ['and', 'or'],
            description: 'Match all (and) or match any (or) of the rows.',
          },
          conditions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: {
                  type: 'string',
                  description:
                    'Field id: a built-in (kind, status, priority, type, assignee, reporter, sprint, text, created, updated, due, storyPoints, estimate), a label/component (lbl, cmp), or a custom field (cf:<fieldId>).',
                },
                operator: {
                  type: 'string',
                  enum: [
                    'is_any_of',
                    'is_none_of',
                    'is_empty',
                    'is_not_empty',
                    'contains',
                    'not_contains',
                    'eq',
                    'ne',
                    'lt',
                    'lte',
                    'gt',
                    'gte',
                    'on_or_before',
                    'on_or_after',
                    'between',
                    'in_last_days',
                    'in_next_days',
                  ],
                  description: 'The operator (must be in the field’s set).',
                },
                value: {
                  anyOf: [
                    { type: 'array', items: { type: 'string' } },
                    { type: 'string' },
                    { type: 'number' },
                    { type: 'null' },
                  ],
                  description:
                    'Value by operator arity: a string list for is_any_of/is_none_of (and a [from,to] pair for between), a string for contains/not_contains and single dates (YYYY-MM-DD), a number for comparisons and in_last_days/in_next_days, or null for is_empty/is_not_empty.',
                },
              },
              required: ['field', 'operator', 'value'],
              additionalProperties: false,
            },
            maxItems: 20,
            description: 'The filter rows (up to 20). An empty list matches the whole project.',
          },
        },
        required: ['version', 'combinator', 'conditions'],
        additionalProperties: false,
        description:
          'A versioned FilterAST envelope — the SAME shape the /items ?filter= URL and saved filters carry. Omit to search the whole project.',
      },
      cursor: {
        type: 'string',
        description: 'Opaque page cursor from a previous call’s nextCursor.',
      },
      limit: {
        type: 'integer',
        exclusiveMinimum: 0,
        maximum: 50,
        description: 'Page size (1–50, default 50; the List’s server cap).',
      },
      planId: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL — the id of a plan (as returned by `create_plan`) to PROJECT over. When given, the answer is computed over the project’s live tree ⊕ that plan’s proposals, so an agent can check the tree it is proposing BEFORE anyone reviews it. Omit it for the committed tree — a call without this argument behaves exactly as it did before projection existed. Nothing is created, mutated or persisted either way, and a proposal never becomes a work item except by approving the plan in Motir.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  search_work_items_semantic: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      query: {
        type: 'string',
        minLength: 1,
        description:
          'What you are looking for, in your own words — a phrase or a sentence, NOT a keyword. Motir embeds it for you: there is no model to pick and no vector to supply. Describe the CAPABILITY ("cards remember which columns are collapsed"), not a term you hope somebody used.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Candidates to return; 1–50, default 10.',
      },
      minScore: {
        type: 'number',
        minimum: -1,
        maximum: 1,
        description:
          'Optional cosine-similarity floor in [-1, 1]. NO default, deliberately (ADR Amendment 1): a spurious candidate costs one keyed read, a suppressed one costs a duplicate branch of the plan. Filter here only when you know what you asked.',
      },
    },
    required: ['projectKey', 'query'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  skeleton: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5000,
        description:
          'Maximum rows to return; default (and maximum) 5000 — the whole tree. Pass a smaller number for a cheap peek. The response always reports `total`, `returned` and `truncated`, so a bounded answer is never mistaken for a whole one.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  start_sprint: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        minLength: 1,
        description: 'The sprint id (as returned by `list_sprints`).',
      },
      name: { type: 'string', description: 'Optional rename on start.' },
      goal: {
        type: ['string', 'null'],
        description: 'Optional goal edit on start; null clears it, omit to leave unchanged.',
      },
      startDate: { type: 'string', description: 'Optional start (ISO-8601); defaults to now.' },
      endDate: {
        type: 'string',
        description: 'Optional planned end (ISO-8601); must be ≥ startDate.',
      },
    },
    required: ['sprintId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  submit_plan_session: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. Case-insensitive.',
      },
      targetKeys: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: 20,
        description:
          'Optional work-item identifiers (e.g. ["ACME-7", "ACME-9"], case-insensitive) to ANCHOR the conversation at. Omit for the project-wide planning thread. The anchor SET is the thread\'s identity — order and duplicates do not matter, and the same set always resumes the same conversation.',
      },
      requirement: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            description:
              'REQUIRED, non-empty, at the far end. Who this is for, and what becomes possible that is not possible today.',
          },
          behaviour: {
            type: 'string',
            description:
              'REQUIRED, non-empty, at the far end. The observable rules — input → result, and the states that are not the happy path.',
          },
          scopeEdge: {
            type: 'string',
            description:
              'What is deliberately NOT included. May be "" — which says you considered it and there is none, a different answer from never having asked.',
          },
          constraints: {
            type: 'string',
            description:
              'What BINDS the shape and is already decided. May be "" (see `scopeEdge`).',
          },
          acceptance: {
            type: 'string',
            description:
              'REQUIRED, non-empty, at the far end. How somebody will know it is done, as an observation rather than a test name.',
          },
          assumptions: {
            type: 'string',
            description: 'What you concluded that nobody confirmed. May be "" (see `scopeEdge`).',
          },
        },
        additionalProperties: false,
        description:
          'OPTIONAL. WHAT you want built, as six named fields instead of prose — the planner reads this INSTEAD of asking you what is wrong. Supply as much as you actually know: nothing here is validated, and a partial requirement submits fine. Three fields (`outcome`, `behaviour`, `acceptance`) must be present and non-empty for the planner to treat the requirement as settled; short of that it simply opens the conversation, which is the same thing it does when you omit this argument entirely.',
      },
    },
    required: ['projectKey'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  transition_status: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      status: {
        type: 'string',
        minLength: 1,
        description:
          'The target status — its key (e.g. "in_progress") or display name (e.g. "In progress").',
      },
    },
    required: ['key', 'status'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  unarchive_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  unlink_pull_request: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      repository: {
        type: 'string',
        description:
          'The repository as "owner/name", exactly as it is connected in Motir (case-insensitive). Give this WITH `number`, or give `url` instead — not neither.',
      },
      number: {
        type: 'integer',
        exclusiveMinimum: 0,
        description: 'The pull-request number, e.g. 2291. Give this with `repository`.',
      },
      url: {
        type: 'string',
        description:
          'The full pull-request URL, e.g. "https://github.com/acme/web/pull/2291". An alternative to `repository` + `number`, never a supplement: if both are given they must agree.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  unlink_work_items: {
    type: 'object',
    properties: {
      fromKey: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      toKey: { $ref: '#/properties/fromKey' },
      relationship: {
        type: 'string',
        enum: ['blocked_by', 'blocks', 'relates_to', 'duplicates', 'clones'],
        description:
          'The relationship FROM the first item TO the second, read "fromKey <relationship> toKey": "blocked_by" (fromKey is blocked by toKey — the dependency edge that holds fromKey out of the ready set), "blocks" (the inverse — fromKey blocks toKey), "relates_to", "duplicates", or "clones".',
      },
    },
    required: ['fromKey', 'toKey', 'relationship'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_plan: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      title: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
        description:
          "The plan's own short label — what it is proposing, in a line. `null` clears it. Omit it to leave it exactly as it is.",
      },
      summary: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
        description:
          'The longer summary (Markdown) shown to the reviewer above the tree — the sentence they read before any card. `null` clears it. Omit it to leave it exactly as it is.',
      },
    },
    required: ['planId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_plan_item: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      planItemId: {
        type: 'string',
        minLength: 1,
        description:
          'The proposal to deepen — one of the ids `add_plan_items` returned in `planItemIds`, in the order you sent them.',
      },
      title: {
        type: 'string',
        minLength: 1,
        description: 'Replace the proposed title. Cannot be blanked — a proposal needs a title.',
      },
      kind: {
        type: 'string',
        enum: ['epic', 'story', 'task', 'bug', 'subtask'],
        description: 'Replace the proposed kind.',
      },
      descriptionMd: {
        type: ['string', 'null'],
        description:
          'Markdown body — WHAT to do. Send `null` to clear it; omit to leave it as it is.',
      },
      explanationMd: {
        type: ['string', 'null'],
        description:
          'Markdown body — WHY it matters. Send `null` to clear it; omit to leave it as it is.',
      },
      type: {
        anyOf: [
          {
            type: 'string',
            enum: [
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
            ],
          },
          { type: 'null' },
        ],
        description:
          'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum; `null` clears it.',
      },
      priority: {
        anyOf: [
          { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
          { type: 'null' },
        ],
        description: 'Priority; `null` clears it.',
      },
      executor: {
        anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
        description:
          'WHO executes this leaf. Worth setting whenever you set `type`: approving a plan does NOT derive an executor from the type, so a proposal that never carried one materializes unassigned. `null` clears it.',
      },
      storyPoints: {
        type: ['number', 'null'],
        description:
          'Agile sizing, re-validated on the merged result exactly as at append; `null` clears it.',
      },
      estimateMinutes: {
        anyOf: [{ type: 'integer' }, { type: 'null' }],
        description: 'Estimated minutes of work; `null` clears it.',
      },
      todos: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description:
                    'WHAT to do — ONE operation, at most 200 characters. "Change this one setting", "run this one command". Navigation is NOT an operation: "go to the dashboard and find the panel" belongs in `notesMd` of the row that then changes something.',
                },
                notesMd: {
                  type: ['string', 'null'],
                  description:
                    'The INSTRUCTIONS for this one operation — Markdown, at most 2000 characters. The HOW, where `text` is the WHAT.',
                },
                commandText: {
                  type: ['string', 'null'],
                  description:
                    'The command this step runs, if it runs one — at most 500 characters, and in this field rather than inside `text`, because this is what the reader copies.',
                },
                executor: {
                  anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
                  description:
                    'Who this STEP is for, when it differs from the card’s. Omit it and the row inherits the proposal’s own `executor` at approve, falling back to `human`.',
                },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
          { type: 'null' },
        ],
        description:
          'The card’s ORDERED STEPS, written as its to-do list. ARRAY ORDER IS LIST ORDER — the sequence they are performed in — and approving the plan writes one real to-do row per element, none ticked. A `manual` card’s steps belong HERE, not only in the description: the reviewer reads the list they will tick before they approve it, and the created card carries it from birth. Leaf kinds only — a container’s steps are its children. REPLACES the list whole — a list has no sparse edit — so send the set you want; `[]` or `null` clears it, and omitting it leaves the proposal’s list alone.',
      },
    },
    required: ['planId', 'planItemId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_plan_proposal: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      planItemId: {
        type: 'string',
        minLength: 1,
        description:
          'The proposal to correct — one of the ids `add_plan_items` returned in `planItemIds`, in the order you sent them.',
      },
      title: {
        type: 'string',
        minLength: 1,
        description: 'Replace the proposed title. Cannot be blanked — a proposal needs a title.',
      },
      kind: {
        type: 'string',
        enum: ['epic', 'story', 'task', 'bug', 'subtask'],
        description: 'Replace the proposed kind.',
      },
      descriptionMd: {
        type: ['string', 'null'],
        description:
          'Markdown body — WHAT to do. Send `null` to clear it; omit to leave it as it is.',
      },
      explanationMd: {
        type: ['string', 'null'],
        description:
          'Markdown body — WHY it matters. Send `null` to clear it; omit to leave it as it is.',
      },
      type: {
        anyOf: [
          {
            type: 'string',
            enum: [
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
            ],
          },
          { type: 'null' },
        ],
        description:
          'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum; `null` clears it.',
      },
      priority: {
        anyOf: [
          { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
          { type: 'null' },
        ],
        description: 'Priority; `null` clears it.',
      },
      executor: {
        anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
        description:
          'WHO executes this leaf. Worth setting whenever you set `type`: approving a plan does NOT derive an executor from the type, so a proposal that never carried one materializes unassigned. `null` clears it.',
      },
      storyPoints: {
        type: ['number', 'null'],
        description:
          'Agile sizing, re-validated on the merged result exactly as at append; `null` clears it.',
      },
      estimateMinutes: {
        anyOf: [{ type: 'integer' }, { type: 'null' }],
        description: 'Estimated minutes of work; `null` clears it.',
      },
      todos: {
        anyOf: [
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description:
                    'WHAT to do — ONE operation, at most 200 characters. "Change this one setting", "run this one command". Navigation is NOT an operation: "go to the dashboard and find the panel" belongs in `notesMd` of the row that then changes something.',
                },
                notesMd: {
                  type: ['string', 'null'],
                  description:
                    'The INSTRUCTIONS for this one operation — Markdown, at most 2000 characters. The HOW, where `text` is the WHAT.',
                },
                commandText: {
                  type: ['string', 'null'],
                  description:
                    'The command this step runs, if it runs one — at most 500 characters, and in this field rather than inside `text`, because this is what the reader copies.',
                },
                executor: {
                  anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
                  description:
                    'Who this STEP is for, when it differs from the card’s. Omit it and the row inherits the proposal’s own `executor` at approve, falling back to `human`.',
                },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
          { type: 'null' },
        ],
        description:
          'The card’s ORDERED STEPS, written as its to-do list. ARRAY ORDER IS LIST ORDER — the sequence they are performed in — and approving the plan writes one real to-do row per element, none ticked. A `manual` card’s steps belong HERE, not only in the description: the reviewer reads the list they will tick before they approve it, and the created card carries it from birth. Leaf kinds only — a container’s steps are its children. REPLACES the list whole — a list has no sparse edit — so send the set you want; `[]` or `null` clears it, and omitting it leaves the proposal’s list alone.',
      },
      parentRef: {
        type: ['string', 'null'],
        description:
          '`add` only: re-parent the proposal. A work-item KEY ("ACME-7"), a real work-item id, or a `planItem:<id>` ref naming another `add` on THIS plan; `null` makes it top-level. Re-validated by the same checks the append runs, so a key or a ref naming nothing is refused here rather than at approve — and a ref to the proposal ITSELF is refused too.',
      },
      blockedByRefs: {
        type: 'array',
        items: {
          type: 'string',
          description:
            'A work-item KEY ("ACME-7", the identifier every other tool takes, case-insensitive); a real work-item id; or a `planItem:<id>` ref naming another `add` on THIS plan. A key is resolved to its id by this call, exactly as `add_plan_items` resolves one, so the three are interchangeable (MOTIR-3934).',
        },
        description:
          'REPLACES the dependency edges wholesale — a list has no sparse edit, so send the set you want and `[]` to clear it. Same ref rules and same re-validation as `parentRef`.',
      },
      targetRepo: {
        type: ['string', 'null'],
        description:
          '`add` only: re-pin WHICH REPO this proposal ships in, validated against the project’s connected repositories; `null` unpins it.',
      },
      targetRepoRole: {
        type: ['string', 'null'],
        description:
          '`add` only: re-pin the PORTABLE half of the pin — a ROLE of the project’s repository set, validated against the closed role vocabulary rather than the project’s rows; `null` unpins it. This is the pin an ONBOARDING plan actually carries, because its repositories do not exist yet.',
      },
      patch: {
        anyOf: [
          {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Re-title the target.' },
              descriptionMd: {
                type: ['string', 'null'],
                description: 'Markdown body — WHAT to do. An explicit `null` clears it.',
              },
              explanationMd: {
                type: ['string', 'null'],
                description:
                  'Markdown body — WHY it matters. An explicit `null` clears it. Patch it whenever a re-scope moves the card’s rationale: a survivor keeps its OLD explanation unless you rewrite it, and a stale WHY is worse than a null one.',
              },
              priority: {
                anyOf: [
                  { type: 'string', enum: ['lowest', 'low', 'medium', 'high', 'highest'] },
                  { type: 'null' },
                ],
              },
              type: {
                anyOf: [
                  {
                    type: 'string',
                    enum: [
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
                    ],
                  },
                  { type: 'null' },
                ],
                description:
                  'Leaf work type. A CLOSED set: these fourteen members ARE the schema enum. An explicit `null` clears it.',
              },
              storyPoints: {
                type: ['number', 'null'],
                description: 'Re-scope the agile sizing. An explicit `null` clears it.',
              },
              estimateMinutes: {
                anyOf: [{ type: 'integer' }, { type: 'null' }],
                description: 'Re-scope the time estimate. An explicit `null` clears it.',
              },
              targetRepo: {
                type: ['string', 'null'],
                description: 'RE-PIN which repo the item ships in. An explicit `null` unpins it.',
              },
              targetRepoRole: {
                type: ['string', 'null'],
                description: 'RE-PIN the portable repo role. An explicit `null` unpins it.',
              },
              parentRef: {
                type: ['string', 'null'],
                description:
                  'RE-PARENT the target: a work-item KEY ("ACME-7") or a real work-item id — the card this one should hang under instead. An explicit `null` moves it to the PROJECT ROOT. Omit the key to leave the parent where it is. ⚠️ It must name a work item that ALREADY EXISTS — a `planItem:<id>` ref is refused, because every check a re-parent owes (the kind-parent matrix, same-project, no cycle, the depth cap, and a refusal to hang new work under a FINISHED parent) is a question about a live row. To land a card under one this plan is adding, `add` it with that `parentRef` instead.',
              },
              blockedByAdd: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Dependency edges to ADD — work-item keys ("ACME-7"), real work-item ids, or `planItem:<id>` refs.',
              },
              blockedByRemove: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Dependency edges to REMOVE — work-item keys ("ACME-7"), real work-item ids, or `planItem:<id>` refs.',
              },
            },
            additionalProperties: true,
            description:
              '`modify` only: the SPARSE patch to apply to the target at approve. A key you omit is left untouched; an explicit `null` CLEARS a nullable field. Nothing is applied until someone approves the plan in Motir.',
          },
          { type: 'null' },
        ],
        description:
          '`modify` only: REPLACES that proposal’s patch. This is the op no door could touch at all before — and the one that carries a dependency edit, so it is usually what a mistyped `planItem:` ref is sitting on.',
      },
    },
    required: ['planId', 'planItemId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_sprint: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        minLength: 1,
        description: 'The sprint id (as returned by `list_sprints`).',
      },
      name: { type: 'string', description: 'New name (omit to leave unchanged).' },
      goal: {
        type: ['string', 'null'],
        description: 'New goal; null clears it, omit to leave unchanged.',
      },
      startDate: {
        type: ['string', 'null'],
        description: 'New planned start (ISO-8601); null clears it, omit to leave unchanged.',
      },
      endDate: {
        type: ['string', 'null'],
        description:
          'New planned end (ISO-8601, ≥ startDate); null clears it, omit to leave unchanged.',
      },
    },
    required: ['sprintId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  update_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item identifier — the project key, a dash, the number (e.g. "ACME-7"). Case-insensitive.',
      },
      title: { type: 'string', minLength: 1, description: 'New title (one line).' },
      descriptionMd: {
        type: ['string', 'null'],
        description: 'New Markdown description body; null clears it.',
      },
      explanationMd: {
        type: ['string', 'null'],
        description: 'New Markdown explanation body (the "why"); null clears it.',
      },
      priority: {
        type: 'string',
        enum: ['lowest', 'low', 'medium', 'high', 'highest'],
        description: 'New priority (lowest…highest).',
      },
      type: {
        anyOf: [
          {
            type: 'string',
            enum: [
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
            ],
          },
          { type: 'null' },
        ],
        description:
          'New work type (code, design, test, …) — leaf items only; null clears it. Setting a type the first time seeds the executor from the type default.',
      },
      executor: {
        anyOf: [{ type: 'string', enum: ['coding_agent', 'human'] }, { type: 'null' }],
        description:
          'Who executes the work ("coding_agent" or "human") — leaf items only; null clears it.',
      },
      estimateMinutes: {
        anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
        description: 'Estimated minutes of work; null clears it.',
      },
      storyPoints: {
        anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }],
        description:
          'Story-point estimate (the agile sizing number, distinct from the time estimate above): a non-negative number ≤ 9999.99 with at most two decimal places. null clears it.',
      },
      targetRepo: {
        type: ['string', 'null'],
        description:
          'WHICH REPO this item ships in — the bare repo name (e.g. "motir-core") or the "owner/name" form; must name one of the workspace\'s CONNECTED repositories. Routes the CLI to the right checkout at dispatch (one subtask = one repo = one PR). null clears the pin.',
      },
      targetRepos: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Replace the repository SET wholesale — EVERY repository this item ships in, ORDERED, the FIRST element being the PRIMARY the CLI is dispatched into. The item does not complete until every repository on the list has a pull request merged onto that repository's own default branch, so use it for a card that legitimately spans repositories (a story or a task — ONE SUBTASK is still ONE REPO). Same validation as create; `[]` clears the set. MUTUALLY EXCLUSIVE with targetRepo, which IS this list's first element: supplying both is rejected rather than silently resolved.",
      },
      targetRepositories: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Replace the repository set wholesale, as REFERENCES to the project's repository ROWS — their ids, ORDERED, the FIRST being the PRIMARY the CLI is dispatched into. Prefer this over targetRepos when you have the ids: a reference survives a rename and can name one of two rows sharing a role. Same validation as create; `[]` clears the set. MUTUALLY EXCLUSIVE with BOTH targetRepo and targetRepos.",
      },
      assigneeId: {
        type: ['string', 'null'],
        description: 'New assignee user id (must be a workspace member); null unassigns.',
      },
      dueDate: {
        type: ['string', 'null'],
        description: 'Due date as an ISO-8601 string; null clears it.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  validate_plan: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        minLength: 1,
        description: 'The plan id `create_plan` returned (or the id shown on the plan in Motir).',
      },
      condition: {
        type: 'string',
        enum: ['loose', 'tight'],
        default: 'loose',
        description:
          'How strict to be about a DONE gating item that sits OUTSIDE the set (sprint / subtree). `loose` (default): a done item outside the set counts as satisfied. `tight`: only an in-set item satisfies — a done item outside the set is reported as a blocker.',
      },
    },
    required: ['planId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  validate_sprint: {
    type: 'object',
    properties: {
      projectKey: {
        type: 'string',
        minLength: 1,
        description:
          'The project key the sprint belongs to — the prefix chosen for that project at creation (e.g. "ACME"), not a reserved value. REQUIRED unless `planId` is given, which names its own project.',
      },
      sprintId: {
        type: 'string',
        minLength: 1,
        description:
          'The sprint to validate; omit to validate the project’s ACTIVE sprint. Not accepted with `planId` — a projected verdict is always about the ACTIVE sprint.',
      },
      condition: {
        type: 'string',
        enum: ['loose', 'tight'],
        default: 'loose',
        description:
          'How strict to be about a DONE gating item that sits OUTSIDE the set (sprint / subtree). `loose` (default): a done item outside the set counts as satisfied. `tight`: only an in-set item satisfies — a done item outside the set is reported as a blocker.',
      },
      planId: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL — the id of a plan (as returned by `create_plan`) to PROJECT over. When given, the answer is computed over the project’s live tree ⊕ that plan’s proposals, so an agent can check the tree it is proposing BEFORE anyone reviews it. Omit it for the committed tree — a call without this argument behaves exactly as it did before projection existed. Nothing is created, mutated or persisted either way, and a proposal never becomes a work item except by approving the plan in Motir.',
      },
    },
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  validate_work_item: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        minLength: 1,
        description:
          'The work item to validate — the project key, a dash, the number (e.g. "ACME-7"), case-insensitive. With `planId`, this may instead be a `planItem:<id>` temp-ref naming an `add` in that plan (case-SENSITIVE, as `add_plan_items` returned it).',
      },
      condition: {
        type: 'string',
        enum: ['loose', 'tight'],
        default: 'loose',
        description:
          'How strict to be about a DONE gating item that sits OUTSIDE the set (sprint / subtree). `loose` (default): a done item outside the set counts as satisfied. `tight`: only an in-set item satisfies — a done item outside the set is reported as a blocker.',
      },
      planId: {
        type: 'string',
        minLength: 1,
        description:
          'OPTIONAL — the id of a plan (as returned by `create_plan`) to PROJECT over. When given, the answer is computed over the project’s live tree ⊕ that plan’s proposals, so an agent can check the tree it is proposing BEFORE anyone reviews it. Omit it for the committed tree — a call without this argument behaves exactly as it did before projection existed. Nothing is created, mutated or persisted either way, and a proposal never becomes a work item except by approving the plan in Motir.',
      },
    },
    required: ['key'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  whoami: {
    type: 'object',
    properties: {},
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
  withdraw_plan_proposal: {
    type: 'object',
    properties: {
      planId: { type: 'string', minLength: 1, description: 'The plan id `create_plan` returned.' },
      planItemId: {
        type: 'string',
        minLength: 1,
        description:
          'The proposal to take off the plan — one of the ids `add_plan_items` returned.',
      },
    },
    required: ['planId', 'planItemId'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
  },
};
