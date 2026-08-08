import {
  API_MAJOR,
  GENERATED_AGAINST,
  V1_OPERATIONS,
  validators,
  type V1OperationId,
  type ValidationError,
  type operations,
} from './api/index.js';
import { normalizeServerUrl } from './config/userConfig.js';
import {
  AuthError,
  CliError,
  IncompatibleServerError,
  NotFoundError,
  RateLimitError,
  ResponseShapeError,
  ScopeError,
} from './errors.js';

// The `/api/v1` TRANSPORT CORE (Story 11.5 · Subtask 11.5.3 — MOTIR-2211),
// implementing `docs/decisions/cli-v1-client.md` Q3 and Q5.
//
// One `request()` that speaks the public REST API, VALIDATES what comes back,
// and turns an HTTP status into the CLI error `src/index.ts` already knows how
// to print. It replaces three functions that exist only because MCP reports
// failures in band:
//
//   callStructured  — `result.structuredContent as T`, an unchecked cast
//   mapCallError    — a catch-all over an SDK exception
//   isUnauthorized  — `/\b401\b|unauthorized/i` over an error MESSAGE
//
// ⚠️ This card ships NO typed method. `MotirClient`'s 19 wrappers still speak
// MCP; 11.5.4 and 11.5.5 port them onto this layer, and 11.5.6 deletes the SDK.
// The point of landing it alone is that the failure paths — a 429 with a reset
// header, a corrupted body, a major mismatch — can be driven directly against a
// stub server rather than reached incidentally through a method port.

/** How the transport is constructed. */
export interface V1TransportOptions {
  /** The Motir server, in any form `normalizeServerUrl` accepts. */
  serverUrl: string;
  /** The PAT. Sourced by the caller from the user config, unchanged by this card. */
  token: string;
  /**
   * The `fetch` to use. Present for tests, which drive a REAL stub HTTP server
   * over a real socket rather than replacing this — the default is the right
   * one everywhere else, and a mocked `fetch` would prove nothing about the
   * request actually put on the wire.
   */
  fetchImpl?: typeof fetch;
  /** Now, for the 429 hint's relative arithmetic. */
  now?: () => Date;
}

/** The path parameters an operation takes, from the generated document. */
type PathParams<Id extends V1OperationId> = operations[Id]['parameters']['path'];

/** The query parameters an operation takes, from the generated document. */
type QueryParams<Id extends V1OperationId> = operations[Id]['parameters']['query'];

/** The request body an operation takes, from the generated document. */
type RequestBody<Id extends V1OperationId> = operations[Id]['requestBody'] extends {
  content: { 'application/json': infer B };
}
  ? B
  : never;

/**
 * The 2xx body an operation answers with, from the generated document.
 *
 * `void` for a 204 (`deleteWorkItemLink`), which declares no content at all —
 * a real shape rather than a gap, and the one operation with no validator.
 *
 * The three success codes are tried in turn because an operation declares
 * exactly one of them, and which one is a property of the operation rather than
 * of the caller. 202 is not a lesser 200: an expansion submit ANSWERS with a
 * job handle it has already committed, and typing that body `void` would have
 * left the one shape the caller needs unreachable without a cast — which is the
 * defect the whole no-`as`-on-a-wire-payload discipline exists to prevent.
 */
export type SuccessBody<Id extends V1OperationId> = operations[Id]['responses'] extends {
  200: { content: { 'application/json': infer B } };
}
  ? B
  : operations[Id]['responses'] extends { 201: { content: { 'application/json': infer B } } }
    ? B
    : operations[Id]['responses'] extends { 202: { content: { 'application/json': infer B } } }
      ? B
      : void;

/** What one call supplies, beyond the operation's identity. */
export interface RequestInput<Id extends V1OperationId> {
  path?: PathParams<Id>;
  query?: QueryParams<Id>;
  body?: RequestBody<Id>;
}

/** The v1 error envelope, as `lib/api/v1/errors.ts` emits it. */
interface V1ErrorEnvelope {
  code: string;
  error: string;
}

/**
 * Read a v1 error envelope out of a parsed body, or report its absence.
 *
 * Absence is load-bearing, not a nuisance case: a 404 WITHOUT an envelope means
 * the PATH is not routed (Next's own 404), which is what arms the skew probe.
 * A 404 WITH one means the item does not exist, which is an ordinary answer.
 */
function readEnvelope(body: unknown): V1ErrorEnvelope | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const candidate: Record<string, unknown> = { ...body };
  const { code, error } = candidate;
  if (typeof code !== 'string' || typeof error !== 'string') return undefined;
  return { code, error };
}

/**
 * The legal targets an illegal-transition refusal names, as one printable list.
 *
 * Reads DEFENSIVELY — every element is checked for a string `label` — because
 * this runs on a FAILURE path, where nothing has been validated: `mapFailure`
 * gets the raw parsed body, and an error response has no generated validator to
 * stand behind it. A malformed enrichment must cost the hint, never the error
 * the user was already being shown.
 *
 * Labels, not keys: it lands inside a sentence the server wrote for a person,
 * so "To Do, In Review" belongs there rather than `todo, in_review`.
 */
function readAllowedTransitions(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const raw = (body as { allowedTransitions?: unknown }).allowedTransitions;
  if (!Array.isArray(raw)) return undefined;
  const labels = raw
    .map((entry) =>
      typeof entry === 'object' && entry !== null
        ? (entry as { label?: unknown }).label
        : undefined,
    )
    .filter((label): label is string => typeof label === 'string');
  // An EMPTY list is a real answer — a terminal status has nowhere to go — but
  // "Allowed: ." reads as a bug, so the sentence stands alone.
  return labels.length > 0 ? labels.join(', ') : undefined;
}

/**
 * The field an Ajv error is ABOUT, as a user-readable path.
 *
 * See `ResponseShapeError`'s note: `instancePath` alone is the parent for the
 * missing- and additional-property cases, which are exactly the renamed-field
 * failures this migration exists to surface.
 */
export function describeField(error: ValidationError): string {
  const params: Record<string, unknown> = { ...error.params };
  const named = params['missingProperty'] ?? params['additionalProperty'];
  const suffix = typeof named === 'string' ? `/${named}` : '';
  return `${error.instancePath}${suffix}` || '(root)';
}

/** The MAJOR of a `MAJOR.MINOR.PATCH` string, or `undefined` if it is not one. */
function versionParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Is `served` BEHIND `generated` within the same major?
 *
 * Exported because it is the whole substance of the skew rule and it must be
 * assertable on its own: with today's `GENERATED_AGAINST` of `1.0.0` there is no
 * version below it inside major 1, so an end-to-end test could only exercise
 * this by coincidence of a constant that is expected to move.
 */
export function isVersionBehind(
  served: [number, number, number],
  generated: [number, number, number],
): boolean {
  if (served[1] !== generated[1]) return served[1] < generated[1];
  return served[2] < generated[2];
}

/**
 * The generated validator for one operation, AS A TYPE GUARD.
 *
 * ⚠️ This is the ONE assertion in the file, and it is deliberately about a
 * FUNCTION rather than a payload. Ajv's generated validators are typed
 * `(data: unknown) => boolean`; re-typing one as a predicate over
 * `SuccessBody<Id>` is the standard idiom, and it is what lets `request()`
 * return a narrowed value with NO cast on the wire payload itself. The claim it
 * makes — "this validator accepts exactly this operation's success body" — is
 * true by construction (both sides are generated from the same document, keyed
 * by the same `operationId`) and asserted over every row by
 * `test/api-validators.test.ts`.
 *
 * `undefined` only for a 204, which declares no body to validate.
 */
function validatorFor<Id extends V1OperationId>(
  operationId: Id,
): ((data: unknown) => data is SuccessBody<Id>) | undefined {
  const table: Record<string, unknown> = { ...validators };
  const candidate = table[`operation_${operationId}`];
  if (typeof candidate !== 'function') return undefined;
  return candidate as (data: unknown) => data is SuccessBody<Id>;
}

/**
 * The `/api/v1` transport.
 *
 * Stateless per call apart from ONE latch: the version-skew probe runs at most
 * once per instance, because its whole purpose is to replace N confusing
 * field-level failures with one accurate sentence.
 */
export class V1Transport {
  private readonly serverUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  /** The skew probe's latch: `undefined` until it has run, then its verdict. */
  private skewVerdict: IncompatibleServerError | null | undefined;

  constructor(opts: V1TransportOptions) {
    this.serverUrl = normalizeServerUrl(opts.serverUrl);
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** The absolute URL one operation's call goes to. */
  buildUrl<Id extends V1OperationId>(operationId: Id, input: RequestInput<Id> = {}): string {
    const row = V1_OPERATIONS[operationId];
    const path = row.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const params: Record<string, unknown> = { ...(input.path ?? {}) };
      const value = params[name];
      if (value === undefined || value === null) {
        throw new CliError(`Internal: ${operationId} needs a '${name}' path parameter.`);
      }
      return encodeURIComponent(String(value));
    });

    const url = new URL(`${this.serverUrl}${path}`);
    // ⚠️ A `cursor` passes through here UNTOUCHED and is never inspected,
    // rebuilt, merged or carried to another collection. It is opaque, signed and
    // collection-scoped (ADR §5); a client that took it apart would be relying
    // on an encoding the server is free to change.
    // ⚠️ An ARRAY value spreads into REPEATED KEYS — `?kind=a&kind=b` — and
    // anything else takes exactly one key. Both forms come from the document
    // rather than from a convention invented here: the array parameters declare
    // `explode: true`, which is that wire form, and `parseReadyFilters` reads
    // them with `params.getAll`. An empty array therefore sends NO key at all,
    // which is the same request as omitting the filter — the only reading that
    // could be right, since `?kind=` matches nothing rather than everything.
    //
    // (Until MOTIR-2317 no operation declared an array and this set one value
    // per key. The document was wrong, not the encoder: the ready set's
    // `kind` / `priority` had been repeatable since they shipped.)
    for (const [key, value] of Object.entries({ ...(input.query ?? {}) })) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        // No per-element skip: the outer guard already handles an ABSENT
        // parameter, and an element cannot be absent — every declared array is
        // `string[]`, so a null inside one would be a caller lying to the type
        // rather than a case to defend against.
        for (const element of value) url.searchParams.append(key, String(element));
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Call one operation and return its VALIDATED body.
   *
   * The return type is derived from the generated document, so there is no `as`
   * anywhere on the path a wire payload takes — the validator is what makes the
   * declared type true, and a body that does not match raises rather than
   * reaching a renderer.
   */
  async request<Id extends V1OperationId>(
    operationId: Id,
    input: RequestInput<Id> = {},
  ): Promise<SuccessBody<Id>> {
    const row = V1_OPERATIONS[operationId];
    const url = this.buildUrl(operationId, input);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: row.method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
    } catch (err) {
      throw new CliError(
        `Could not reach ${this.serverUrl}: ${err instanceof Error ? err.message : String(err)}.`,
        { hint: 'Check the server URL and run `motir doctor`.' },
      );
    }

    const rawBody = await response.text();
    const parsed = rawBody === '' ? undefined : safeJson(rawBody);

    if (!response.ok) throw await this.mapFailure(operationId, response, parsed);

    // A 204 declares no content, so `SuccessBody` is `void` and there is
    // nothing to validate. The assertion is over `undefined`, not over anything
    // that came off the wire.
    if (row.successStatus === 204) return undefined as SuccessBody<Id>;

    const validate = validatorFor(operationId);
    /* v8 ignore next 6 -- unreachable: the operation table and the validator set
       are generated from the same document, so every non-204 row has one. Kept
       as a THROW rather than a pass-through, because returning an unvalidated
       body would be the exact defect this card removes. */
    if (!validate) {
      throw new CliError(`Internal: no response validator generated for ${operationId}.`);
    }

    if (!validate(parsed)) {
      // A shape mismatch is the strongest signal of skew there is — the server
      // is answering with something this client was not generated against — so
      // the probe runs BEFORE the field-level error is raised. If the probe has
      // a verdict, the user gets one accurate sentence instead of a field name
      // they cannot act on.
      const skew = await this.checkSkew();
      if (skew) throw skew;

      const errors = (validate as { errors?: ValidationError[] | null }).errors ?? [];
      const first = errors[0];
      throw new ResponseShapeError(
        this.serverUrl,
        operationId,
        first ? describeField(first) : '(root)',
        first?.message ?? 'did not match the expected shape',
      );
    }

    // `parsed` is narrowed by the guard above — no cast, which is the whole
    // point of parsing instead of casting.
    return parsed;
  }

  /**
   * The status → error map, exactly as `cli-v1-client.md` Q5 pins it.
   *
   * ⚠️ It branches on the STATUS and on the envelope's machine `code`, never on
   * the human `error` sentence — which is what the ADR itself instructs every
   * client to do ("MUST NOT parse the human `error` sentence — only the machine
   * `code`"), and the whole reason `isUnauthorized`'s regex goes away.
   */
  private async mapFailure(
    operationId: V1OperationId,
    response: Response,
    parsed: unknown,
  ): Promise<CliError> {
    const envelope = readEnvelope(parsed);

    if (response.status === 401) return new AuthError();

    if (response.status === 403) {
      return new ScopeError(V1_OPERATIONS[operationId].scope, operationId);
    }

    if (response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      return new RateLimitError(
        Number.isFinite(reset) && reset > 0 ? reset : undefined,
        this.now(),
      );
    }

    if (response.status === 404) {
      // No envelope means the PATH is not routed — this server does not have
      // the endpoint at all, which is skew rather than a missing item.
      if (!envelope) {
        const skew = await this.checkSkew();
        if (skew) return skew;
        return new CliError(`${this.serverUrl} has no ${operationId} endpoint.`, {
          hint: 'Your CLI and this server may be out of step — run `motir doctor`.',
        });
      }
      return new NotFoundError(envelope.error);
    }

    if (response.status >= 500) {
      const requestId = response.headers.get('x-request-id') ?? 'none';
      return new CliError(
        `The Motir server failed (${response.status}). Request id: ${requestId}.`,
        { hint: 'If it persists, quote the request id when reporting it.' },
      );
    }

    // Every other 4xx the API documents (402 / 409 / 412 / 422) carries the
    // envelope, and the server's own sentence is more specific than anything a
    // client could add — so it is reported verbatim, with NO hint.
    //
    // ⚠️ ONE refusal enriches its envelope, and reading that enrichment is not
    // optional. `POST …/transitions` answers an illegal move with the legal
    // targets in `allowedTransitions`, DELIBERATELY as data rather than folded
    // into the sentence (the route calls this "the refusal TEACHES"). The MCP
    // tool it replaces put that list inside its message, so ignoring the field
    // here would silently downgrade "In Progress → Done is not allowed.
    // Allowed: To Do, In Review." into a dead end the user cannot act on.
    //
    // It joins the MESSAGE rather than the hint, and that placement is load
    // bearing: `motir done` catches this error and re-raises it as
    // `new CliError(err.message, { hint: … })` to add its own one-hop advice,
    // so anything parked in `hint` is discarded on the one command where the
    // targets matter most. Composing the sentence here — not parsing one, which
    // ADR §8 forbids — keeps "the error text names the allowed targets" true
    // for every caller, exactly as it was under MCP.
    if (envelope) {
      const allowed = readAllowedTransitions(parsed);
      return new CliError(allowed ? `${envelope.error} Allowed: ${allowed}.` : envelope.error);
    }
    return new CliError(`${this.serverUrl} answered ${response.status} for ${operationId}.`);
  }

  /**
   * The version-skew gate — a LAZY probe, per `cli-v1-client.md` Q3.
   *
   * Nothing on a `/api/v1` response advertises the contract version (verified by
   * grep at ADR time; MOTIR-2275 would add it). So the CLI does not ask on the
   * happy path at all: this runs only after a failure that skew could explain,
   * at most ONCE per instance, and returns `null` when it has no verdict.
   *
   * The `null` cases matter as much as the verdict. A probe that cannot reach
   * the spec must not invent a diagnosis, and a server at or AHEAD of the
   * generated minor is compatible by construction under ADR §8's additive-only
   * promise — so a parse failure there is a real defect, and reporting it as
   * skew would launder a bug into an upgrade prompt.
   */
  private async checkSkew(): Promise<IncompatibleServerError | null> {
    if (this.skewVerdict !== undefined) return this.skewVerdict;
    this.skewVerdict = await this.probeSkew();
    return this.skewVerdict;
  }

  private async probeSkew(): Promise<IncompatibleServerError | null> {
    let served: string;
    try {
      const response = await this.fetchImpl(`${this.serverUrl}/api/openapi/v1.json`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      const document: unknown = safeJson(await response.text());
      const info =
        typeof document === 'object' && document !== null
          ? ({ ...document } as Record<string, unknown>)['info']
          : undefined;
      const version =
        typeof info === 'object' && info !== null
          ? ({ ...info } as Record<string, unknown>)['version']
          : undefined;
      if (typeof version !== 'string') return null;
      served = version;
    } catch {
      // Unreachable spec, unparseable document: NO verdict. The original error
      // stands, which is the honest outcome — a failed probe is not evidence.
      return null;
    }

    const servedParts = versionParts(served);
    const generatedParts = versionParts(GENERATED_AGAINST);
    if (!servedParts || !generatedParts) return null;

    if (servedParts[0] !== API_MAJOR) {
      return new IncompatibleServerError(
        `This CLI speaks Motir API v${API_MAJOR}, but ${this.serverUrl} serves v${servedParts[0]}.`,
        'Upgrade the CLI: `npm install -g @motir/cli@latest`',
      );
    }

    if (isVersionBehind(servedParts, generatedParts)) {
      return new IncompatibleServerError(
        `This CLI needs Motir API >= ${GENERATED_AGAINST}; ${this.serverUrl} serves ${served}.`,
        'Upgrade your Motir server, or install a CLI built for it.',
      );
    }

    // Same major, at or ahead of the generated minor: NOT skew.
    return null;
  }
}

/** Parse a body, treating unparseable JSON as "no body" rather than throwing. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
