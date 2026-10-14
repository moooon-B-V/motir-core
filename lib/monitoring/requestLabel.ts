import { AsyncLocalStorage } from 'node:async_hooks';

// WHICH REQUEST A TRANSACTION BELONGS TO (MOTIR-8553).
//
// A `TransactionMeasurement` (MOTIR-8550) says how long a transaction waited and
// held; it does not say whether `/workbench` or `move_to_parent` opened it. A hot
// route runs its work under `withRequestLabel`, and the every-request recorder
// (`./requestDbTiming`) reads `currentRequestLabel()` when a measurement arrives.
//
// ⚠️ THE STORE LIVES ON `globalThis`, under a `Symbol.for` key — MOTIR-7007's
// module-instance trap. The Next server evaluates a module once per Turbopack
// runtime, so a route handler and the `lib/workspaces/context.ts` whose
// transaction it opens can hold DIFFERENT copies of this file. Two copies with two
// `AsyncLocalStorage` instances would each see only their own label, and every
// transaction would read as unlabelled. One instance, shared by key, is what makes
// the label one fact across runtimes.
//
// ⚠️ THE LABEL IS CLOSED. `route` is a union of the four hot routes, and a tool
// name is recorded only when the MCP registry registered it, so the series'
// cardinality is bounded by code, never by input.

/** The hot routes that label their work. Everything else is `unlabelled`. */
export const REQUEST_ROUTES = ['workbench', 'workbench_stream', 'plan_get', 'mcp'] as const;
export type RequestRoute = (typeof REQUEST_ROUTES)[number] | 'unlabelled';

export interface RequestLabel {
  readonly route: RequestRoute;
  /** The MCP tool, on `route: 'mcp'`. */
  readonly tool?: string;
}

const STORE_KEY = Symbol.for('motir.requestLabel.store');
const KNOWN_TOOLS_KEY = Symbol.for('motir.requestLabel.knownMcpTools');

type Holder = {
  [STORE_KEY]?: AsyncLocalStorage<RequestLabel>;
  [KNOWN_TOOLS_KEY]?: Set<string>;
};

function store(): AsyncLocalStorage<RequestLabel> {
  const holder = globalThis as Holder;
  holder[STORE_KEY] ??= new AsyncLocalStorage<RequestLabel>();
  return holder[STORE_KEY];
}

function knownTools(): Set<string> {
  const holder = globalThis as Holder;
  holder[KNOWN_TOOLS_KEY] ??= new Set();
  return holder[KNOWN_TOOLS_KEY];
}

/** Run `fn` with `label` as the request's label. An inner label wins. */
export function withRequestLabel<T>(label: RequestLabel, fn: () => T): T {
  return store().run(label, fn);
}

/** The label of the request this code runs inside, or null outside any. */
export function currentRequestLabel(): RequestLabel | null {
  return store().getStore() ?? null;
}

/** Record that the MCP registry registered `tool` — the tool label's allow-list. */
export function registerKnownMcpTool(tool: string): void {
  knownTools().add(tool);
}

/** `tool` when the registry registered it, else `other`. */
export function boundedToolLabel(tool: string | undefined): string {
  if (tool === undefined) return '';
  return knownTools().has(tool) ? tool : 'other';
}
