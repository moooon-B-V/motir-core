import Ajv2020 from 'ajv/dist/2020';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAsCloudBuild } from '../../helpers/cloudBuild';

runAsCloudBuild();

// THE CONTRACT SEAM (MOTIR-4120) — each new route's REAL response, validated
// against the DOCUMENT THIS APPLICATION SERVES.
//
// ── ⚠️ WHY THIS IS NOT `contract-drift.test.ts` ───────────────────────────
//
// That suite parses each response through the ZOD SCHEMA the operation
// declares. This one parses it through the JSON SCHEMA the route at
// `/api/openapi/public.json` actually emits, resolved through
// `components.schemas`. Between the two lies the whole emitter — the zod→JSON
// Schema conversion, the `$defs` hoist, the `$ref` rewrite, the media-type
// selection — and a consumer reads the far side of it. A shape that satisfies
// the zod schema and emits a document that does not describe it is exactly the
// failure a generated client hits and neither existing suite can see.
//
// `public-surface-hosts.md` §3 is why it lives here and not in `motir-marketing`:
// "a contract test that lives only in the consumer reports that motir-core broke
// motir.co, after it has shipped".
//
// ── The population is DERIVED from the document ───────────────────────────
//
// Each case names a path and a method and looks its schema up in the served
// document. An operation that has been renamed, moved or dropped fails on the
// lookup rather than silently validating nothing — which is the vacuous pass a
// hand-maintained schema copy would give.

type JsonObject = Record<string, unknown>;

const getOverview = vi.hoisted(() => vi.fn());
const getBoard = vi.hoisted(() => vi.fn());
const getRoadmap = vi.hoisted(() => vi.fn());
const getWorkItemDetail = vi.hoisted(() => vi.fn());
const getRequestDetail = vi.hoisted(() => vi.fn());
const listPublicIndex = vi.hoisted(() => vi.fn());
const getSession = vi.hoisted(() => vi.fn(async () => null));

vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/services/publicProjectsService', () => ({
  publicProjectsService: {
    getOverview,
    getBoard,
    getRoadmap,
    getWorkItemDetail,
    getRequestDetail,
    listPublicIndex,
  },
}));

const { GET: boardGET } = await import('@/app/api/public/p/[identifier]/board/route');
const { GET: roadmapGET } = await import('@/app/api/public/p/[identifier]/roadmap/route');
const { GET: itemGET } = await import('@/app/api/public/p/[identifier]/items/[key]/route');
const { GET: requestGET } =
  await import('@/app/api/public/p/[identifier]/requests/[requestKey]/route');
const { GET: indexGET } = await import('@/app/api/public/projects/route');
const { GET: documentGET } = await import('@/app/api/openapi/public.json/route');

afterEach(() => vi.clearAllMocks());

/** The document as a consumer receives it — through the ROUTE, not the emitter. */
async function servedDocument(): Promise<JsonObject> {
  const res = await documentGET();
  return (await res.json()) as JsonObject;
}

/**
 * The 200 response schema the document publishes for one operation, as a
 * self-contained JSON Schema with the document's `components` attached so its
 * `$ref`s resolve.
 */
function responseSchemaFor(doc: JsonObject, path: string, mediaType = 'application/json') {
  const paths = doc['paths'] as JsonObject;
  const pathItem = paths[path] as JsonObject | undefined;
  expect(pathItem, `the document publishes no path ${path}`).toBeDefined();

  const operation = (pathItem as JsonObject)['get'] as JsonObject | undefined;
  expect(operation, `the document publishes no GET on ${path}`).toBeDefined();

  const responses = (operation as JsonObject)['responses'] as JsonObject;
  const ok = responses['200'] as JsonObject | undefined;
  expect(ok, `no 200 declared on GET ${path}`).toBeDefined();

  const content = (ok as JsonObject)['content'] as JsonObject;
  const entry = content[mediaType] as JsonObject | undefined;
  expect(
    entry,
    `GET ${path} does not declare ${mediaType} — it declares ${Object.keys(content).join(', ')}`,
  ).toBeDefined();

  return {
    ...((entry as JsonObject)['schema'] as JsonObject),
    components: doc['components'],
  };
}

function validate(schema: JsonObject, body: unknown): void {
  // `strict: false` because an OpenAPI schema object legitimately carries
  // keywords Ajv does not know (`example`, `deprecated`); `allErrors` so a
  // failure names every offending key rather than the first.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const ok = ajv.validate(schema, body);
  expect(ok, ajv.errorsText(ajv.errors, { separator: '\n' })).toBe(true);
}

const identifierParams = { params: Promise.resolve({ identifier: 'ACME' }) };
const url = (path: string) => new Request(`https://app.motir.co${path}`);

describe("each new read's real response validates against the SERVED document", () => {
  it('GET /api/public/p/{identifier}/board', async () => {
    getBoard.mockResolvedValue({
      boardId: 'board_1',
      name: 'Delivery',
      columns: [
        {
          id: 'col_1',
          name: 'In progress',
          statusKeys: ['in_progress'],
          cards: [
            {
              id: 'wi_1',
              identifier: 'ACME-1',
              key: 1,
              title: 'A card',
              kind: 'task',
              status: 'in_progress',
              statusCategory: 'in_progress',
              priority: 'medium',
            },
          ],
          totalCount: 3,
        },
      ],
      cap: 200,
      truncated: false,
    });

    const body = await (await boardGET(url('/api/public/p/ACME/board'), identifierParams)).json();
    validate(responseSchemaFor(await servedDocument(), '/api/public/p/{identifier}/board'), body);
  });

  it('GET /api/public/p/{identifier}/roadmap — the WHOLE-TAB arm', async () => {
    // The union arm a document reader is most likely to get wrong: one path,
    // two response shapes, and the document has to admit both.
    getRoadmap.mockResolvedValue({
      columns: [
        {
          key: 'planned',
          totalCount: 2,
          cards: [
            {
              id: 'wi_2',
              identifier: 'ACME-2',
              key: 2,
              title: 'A card',
              kind: 'task',
              voteCount: 1,
              voted: false,
            },
          ],
          nextCursor: null,
        },
      ],
    });

    const body = await (
      await roadmapGET(url('/api/public/p/ACME/roadmap'), identifierParams)
    ).json();
    validate(responseSchemaFor(await servedDocument(), '/api/public/p/{identifier}/roadmap'), body);
  });

  it('GET /api/public/p/{identifier}/roadmap — the COLUMN-PAGE arm, same path', async () => {
    const { publicProjectsService } = await import('@/lib/services/publicProjectsService');
    (
      publicProjectsService as unknown as { getRoadmapColumn: ReturnType<typeof vi.fn> }
    ).getRoadmapColumn = vi.fn(async () => ({
      bucket: 'planned',
      cards: [],
      nextCursor: 'more',
    }));

    const body = await (
      await roadmapGET(
        url('/api/public/p/ACME/roadmap?bucket=planned&cursor=abc'),
        identifierParams,
      )
    ).json();
    validate(responseSchemaFor(await servedDocument(), '/api/public/p/{identifier}/roadmap'), body);
  });

  it('GET /api/public/p/{identifier}/items/{key}', async () => {
    getWorkItemDetail.mockResolvedValue({
      id: 'wi_3',
      identifier: 'ACME-3',
      key: 3,
      title: 'An item',
      kind: 'task',
      status: 'todo',
      statusLabel: 'To do',
      statusCategory: 'todo',
      descriptionMd: null,
      parent: null,
      childrenHidden: false,
      childCount: 0,
      children: [],
      childrenHasMore: false,
    });

    const body = await (
      await itemGET(url('/api/public/p/ACME/items/ACME-3'), {
        params: Promise.resolve({ identifier: 'ACME', key: 'ACME-3' }),
      })
    ).json();
    validate(
      responseSchemaFor(await servedDocument(), '/api/public/p/{identifier}/items/{key}'),
      body,
    );
  });

  it('GET /api/public/p/{identifier}/requests/{requestKey}', async () => {
    getRequestDetail.mockResolvedValue({
      id: 'wi_4',
      identifier: 'ACME-4',
      key: 4,
      title: 'A request',
      kind: 'task',
      status: 'open',
      statusLabel: 'Open',
      statusCategory: 'todo',
      descriptionMd: 'Please',
      openedByName: 'A Reader',
      createdAt: '2026-08-30T00:00:00.000Z',
      voteCount: 2,
      voted: false,
      comments: [
        {
          id: 'c_1',
          workItemId: 'wi_4',
          parentCommentId: null,
          author: { id: 'u_1', name: 'A Reader', image: null },
          bodyMd: 'Me too',
          editedAt: null,
          createdAt: '2026-08-30T01:00:00.000Z',
          mentionedUserIds: [],
        },
      ],
    });

    const body = await (
      await requestGET(url('/api/public/p/ACME/requests/ACME-4'), {
        params: Promise.resolve({ identifier: 'ACME', requestKey: 'ACME-4' }),
      })
    ).json();
    validate(
      responseSchemaFor(await servedDocument(), '/api/public/p/{identifier}/requests/{requestKey}'),
      body,
    );
  });

  it('GET /api/public/projects', async () => {
    listPublicIndex.mockResolvedValue({
      projects: [{ identifier: 'ACME', updatedAt: '2026-08-30T00:00:00.000Z' }],
      nextCursor: null,
    });

    const body = await (await indexGET(url('/api/public/projects'))).json();
    validate(responseSchemaFor(await servedDocument(), '/api/public/projects'), body);
  });
});

describe('the ATOM feed is declared as XML, in the document a consumer reads', () => {
  it('publishes `application/atom+xml`, and NOT `application/json`', async () => {
    // The one operation on this surface that does not answer JSON. A generated
    // client picks its parser from this, so a document describing it as JSON
    // would tell every consumer to call `.json()` on an XML document — a failure
    // no response-shape check can catch, because the response is correct.
    const doc = await servedDocument();
    const paths = doc['paths'] as JsonObject;
    const feed = paths['/api/public/p/{identifier}/changelog.xml'] as JsonObject;
    const content = ((feed['get'] as JsonObject)['responses'] as JsonObject)['200'] as JsonObject;
    const media = Object.keys(content['content'] as JsonObject);

    expect(media).toEqual(['application/atom+xml']);
  });

  it('every OTHER operation still declares JSON — the media type is per-operation', () => {
    // The change that added a media type had to not change eleven others.
    return servedDocument().then((doc) => {
      const paths = doc['paths'] as JsonObject;
      const nonJson: string[] = [];
      for (const [path, item] of Object.entries(paths as Record<string, JsonObject>)) {
        for (const [method, operation] of Object.entries(item as Record<string, JsonObject>)) {
          const responses = operation['responses'] as JsonObject | undefined;
          const ok = (responses?.['200'] ?? responses?.['201']) as JsonObject | undefined;
          const content = ok?.['content'] as JsonObject | undefined;
          if (content === undefined) continue;
          const media = Object.keys(content);
          if (!media.includes('application/json') && !path.endsWith('changelog.xml')) {
            nonJson.push(`${method.toUpperCase()} ${path} → ${media.join(', ')}`);
          }
        }
      }
      expect(nonJson).toEqual([]);
    });
  });
});
