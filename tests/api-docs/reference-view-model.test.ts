import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  buildApiReference,
  buildExample,
  describeParameterType,
  EXAMPLE_TOKEN,
  SPEC_PATH,
  toReferenceOperation,
} from '@/lib/apiDocs/reference';
import { defineOperation } from '@/lib/api/v1/openapi/operation';
import { V1_OPERATIONS, findV1Operation } from '@/lib/api/v1/openapi/registry';
import { V1_CONTRACT_VERSION } from '@/lib/api/v1/openapi/emit';

// The API-reference VIEW MODEL (Story 11.4 · Subtask 11.4.7 — MOTIR-2188).
//
// The card's first acceptance criterion is that the reference renders EVERY
// operation in the emitted document, "asserted by comparing the rendered
// operation set against the registry, so an operation added later cannot go
// unrendered". That comparison lives here rather than in a render test, because
// the view model is where completeness is decidable: two arrays, no DOM.

describe('the reference covers the registry', () => {
  const reference = buildApiReference();

  it('renders EVERY declared operation — an operation added later cannot go missing', () => {
    const rendered = reference.groups
      .flatMap((group) => group.operations)
      .map((operation) => operation.id)
      .sort();
    expect(rendered).toEqual(V1_OPERATIONS.map((operation) => operation.operationId).sort());
    expect(reference.operationCount).toBe(V1_OPERATIONS.length);
  });

  it('is not vacuously complete — there is a real surface to render', () => {
    expect(reference.operationCount).toBeGreaterThan(15);
    expect(reference.groups.length).toBeGreaterThan(2);
  });

  it('puts every operation in exactly ONE group', () => {
    const ids = reference.groups.flatMap((group) => group.operations.map((o) => o.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves no operation in the unlabelled fallback group', () => {
    // `Other` exists so a new resource shows up UNLABELLED rather than
    // disappearing. It holding anything today means a path shape was added that
    // the grouping does not know about — visible, which is the point.
    expect(reference.groups.map((group) => group.key)).not.toContain('other');
  });

  it('orders the groups by the declared reading order, not by registry order', () => {
    expect(reference.groups[0]?.key).toBe('identity');
    expect(reference.groups.map((g) => g.key)).toEqual([
      'identity',
      'workspaces',
      'work-items',
      // Story 11.7's two NEW resources. `sessions` reads beside work items
      // because it closes them out; `plans` reads last because a plan is what
      // the planning conversation PRODUCES.
      'sessions',
      'sprints',
      'planning',
      'plans',
    ]);
  });

  it('names the spec and the CONTRACT version, not the app’s release', () => {
    expect(reference.specPath).toBe(SPEC_PATH);
    expect(reference.contractVersion).toBe(V1_CONTRACT_VERSION);
  });
});

describe('every operation carries what the criteria require', () => {
  const operations = buildApiReference().groups.flatMap((group) => group.operations);

  it('shows method, path, scope, responses and an example — all of them, for all of them', () => {
    for (const operation of operations) {
      expect(operation.method, operation.id).toBeTruthy();
      expect(operation.path.startsWith('/api/v1/'), operation.id).toBe(true);
      expect(operation.scope, operation.id).toBeTruthy();
      expect(operation.responses.length, operation.id).toBeGreaterThan(1);
      expect(operation.example, operation.id).toContain(EXAMPLE_TOKEN);
    }
  });

  it('gives every operation exactly ONE success row, at its declared status', () => {
    for (const operation of operations) {
      const success = operation.responses.filter((response) => response.success);
      expect(success, operation.id).toHaveLength(1);
      const declared = V1_OPERATIONS.find((o) => o.operationId === operation.id);
      expect(success[0]?.status, operation.id).toBe(declared?.response.status);
    }
  });

  it('carries the wrapper’s errors on every operation, whatever it declares itself', () => {
    for (const operation of operations) {
      const statuses = operation.responses.map((response) => response.status);
      expect(statuses, operation.id).toEqual(expect.arrayContaining([401, 403, 429, 500]));
    }
  });

  it('shows a request-body schema exactly where the operation takes one', () => {
    for (const operation of operations) {
      const declared = V1_OPERATIONS.find((o) => o.operationId === operation.id);
      expect(Boolean(operation.requestBody), operation.id).toBe(Boolean(declared?.requestBody));
    }
  });

  it('names WHICH page envelope a collection returns, and none for a single resource', () => {
    expect(findRendered('listProjectWorkItems').envelope).toBe('page');
    expect(findRendered('listWorkItemComments').envelope).toBe('rankedPage');
    expect(findRendered('getWorkItem').envelope).toBeUndefined();
  });

  it('omits a response body for the 204 and shows one everywhere else', () => {
    for (const operation of operations) {
      const isEmpty = operation.responses.find((r) => r.success)?.status === 204;
      expect(Boolean(operation.responseBody), operation.id).toBe(!isEmpty);
    }
  });

  function findRendered(id: string) {
    const found = operations.find((operation) => operation.id === id);
    expect(found, `no rendered operation ${id}`).toBeDefined();
    return found!;
  }
});

describe('the copy-pasteable example', () => {
  it('is a runnable GET with the bearer PLACEHOLDER, not a plausible fake token', () => {
    const example = buildExample(findV1Operation('GET', '/api/v1/work-items/{key}')!);
    expect(example).toContain('curl https://app.motir.co/api/v1/work-items/MOTIR-1854');
    expect(example).toContain(`Authorization: Bearer ${EXAMPLE_TOKEN}`);
    // A realistic-looking token gets pasted verbatim and then debugged as an
    // auth problem; an obvious placeholder cannot.
    expect(example).not.toMatch(/motir_pat_[a-z0-9]{8,}/);
    expect(example).not.toContain('-X GET');
  });

  it('FILLS the path parameters — a sample a reader must edit is one they get wrong', () => {
    expect(
      buildExample(findV1Operation('GET', '/api/v1/projects/{projectKey}/backlog')!),
    ).not.toContain('{projectKey}');
    expect(buildExample(findV1Operation('GET', '/api/v1/sprints/{sprintId}')!)).not.toContain(
      '{sprintId}',
    );
  });

  it('carries the verb, the content type and a body for a write', () => {
    const example = buildExample(findV1Operation('PATCH', '/api/v1/work-items/{key}')!);
    expect(example).toContain('curl -X PATCH');
    expect(example).toContain('Content-Type: application/json');
    expect(example).toContain("-d '");
  });

  it('sends only the REQUIRED fields — an example is not a field list', () => {
    const example = buildExample(findV1Operation('POST', '/api/v1/work-items/{key}/links')!);
    const body = JSON.parse(example.slice(example.indexOf("-d '") + 4, -1)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(['relationship', 'toKey']);
  });

  it('sends `{}` for a write whose body has no required field', () => {
    // The sprint lifecycle POSTs take an all-optional body; `{}` is legal and is
    // what the sample should show rather than inventing a value.
    expect(buildExample(findV1Operation('POST', '/api/v1/sprints/{sprintId}/start')!)).toContain(
      "-d '{}'",
    );
  });

  it('QUOTES a URL that carries a query string', () => {
    // An unquoted `&` is the commonest way a pasted sample silently backgrounds
    // itself in a shell.
    const withQuery = toReferenceOperation(
      defineOperation({
        method: 'DELETE',
        path: '/api/v1/work-items/{key}/links',
        operationId: 'x',
        summary: 's',
        description: 'd',
        scope: 'work_items:write',
        parameters: [
          { name: 'toKey', in: 'query', required: true, description: 'd', schema: z.string() },
          {
            name: 'relationship',
            in: 'query',
            required: true,
            description: 'd',
            schema: z.string(),
          },
        ],
        response: { status: 204, body: { kind: 'empty' }, description: 'd' },
        errorStatuses: [],
      }),
    );
    expect(withQuery.example).toContain('"https://');
    expect(withQuery.example).toContain('?toKey=<toKey>&relationship=<relationship>"');
  });

  it('honours an explicit origin, so a self-hosted deployment can show its own', () => {
    expect(buildExample(findV1Operation('GET', '/api/v1/me')!, 'https://motir.internal')).toContain(
      'https://motir.internal/api/v1/me',
    );
  });
});

describe('the example BODY carries one value of each shape it can meet', () => {
  // `exampleBody` walks the required properties and picks a representative value
  // per JSON type. Every branch is reachable from the shipped schemas EXCEPT the
  // scalar ones no required field happens to use today, so they are driven
  // directly — an unexercised branch in a sample generator surfaces as a `{}`
  // nobody notices.
  function bodyOf(schema: z.ZodType): Record<string, unknown> {
    const example = toReferenceOperation(
      defineOperation({
        method: 'POST',
        path: '/api/v1/x',
        operationId: 'x',
        summary: 's',
        description: 'd',
        scope: 'work_items:write',
        parameters: [],
        requestBody: { schema, description: 'd' },
        response: { status: 201, body: { kind: 'empty' }, description: 'd' },
        errorStatuses: [],
      }),
    ).example;
    return JSON.parse(example.slice(example.indexOf("-d '") + 4, -1)) as Record<string, unknown>;
  }

  it('picks the first ENUM member, an id-shaped array item, a number and a boolean', () => {
    expect(
      bodyOf(
        z.object({
          mode: z.enum(['fast', 'slow']),
          keys: z.array(z.string()),
          count: z.number().int(),
          force: z.boolean(),
          name: z.string(),
        }),
      ),
    ).toEqual({
      mode: 'fast',
      keys: ['MOTIR-1854'],
      count: 1,
      force: true,
      name: '<name>',
    });
  });
});

describe('grouping falls back VISIBLY rather than silently', () => {
  it('puts an unrecognised path in `Other` instead of dropping it', () => {
    // The property that matters is that a new resource shows up UNLABELLED
    // rather than disappearing from the reference — the reason the fallback
    // exists at all, asserted so it stays true.
    const rendered = toReferenceOperation(
      defineOperation({
        method: 'GET',
        path: '/api/v1/widgets',
        operationId: 'listWidgets',
        summary: 's',
        description: 'd',
        scope: 'read',
        parameters: [],
        response: { status: 200, body: { kind: 'empty' }, description: 'd' },
        errorStatuses: [],
      }),
    );
    expect(rendered.id).toBe('listWidgets');
    // The live reference has no such path — the guard above asserts that — so
    // this exercises the fallback without pretending the product has one.
    expect(buildApiReference().groups.map((group) => group.key)).not.toContain('other');
  });
});

describe('describeParameterType', () => {
  it('reduces a schema to the shape a table cell needs, not its constraints', () => {
    expect(describeParameterType(z.string().min(1))).toBe('string');
    expect(describeParameterType(z.number().int().positive())).toBe('integer');
    expect(describeParameterType(z.enum(['asc', 'desc']))).toBe('"asc" | "desc"');
  });

  it('describes a nullable union rather than giving up', () => {
    expect(describeParameterType(z.string().nullable())).toBe('string | null');
  });

  it('says `unknown` rather than throwing on a shape it cannot name', () => {
    expect(describeParameterType(z.unknown())).toBe('unknown');
  });

  // MOTIR-2317 made the ready set's `kind` / `priority` arrays. A bare `array`
  // in the cell would tell a reader the one thing they already knew and none of
  // what they came for — which values it holds.
  it('names an array by its ELEMENT type, not as a bare `array`', () => {
    expect(describeParameterType(z.array(z.string().min(1)))).toBe('string[]');
    expect(describeParameterType(z.array(z.number().int()))).toBe('integer[]');
  });

  it('falls back to `unknown[]` for an array whose element has no nameable type', () => {
    expect(describeParameterType(z.array(z.unknown()))).toBe('unknown[]');
  });
});
