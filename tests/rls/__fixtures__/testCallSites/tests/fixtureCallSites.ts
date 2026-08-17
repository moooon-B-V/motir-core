// The CALL SITES the classifier is pointed at (MOTIR-2817).
//
// This file is never executed — it is PARSED. Each call below is one verdict, so
// the classifier is proven in both directions instead of trusted. The
// declarations are local for the same reason the fixture repository's are: the
// classifier resolves no imports, it matches identifiers.
//
// ⚠️ Line positions are NOT load-bearing — the guard asserts on
// `(repository, method, verdict)` triples, so adding a comment here cannot break it.

declare const fixtureRepository: {
  findWidgets(workspaceId: string, tx?: unknown): Promise<unknown[]>;
  findGlobalSettings(): Promise<unknown[]>;
  countAllUnsafe(workspaceId: string, tx?: unknown): Promise<number>;
  findWidgetsUnbindable(workspaceId: string): Promise<unknown[]>;
  findWidgetsWrapped(workspaceId: string, limit: number, tx?: unknown): Promise<unknown[]>;
  findGlobalSettingsBindable(tx?: unknown): Promise<unknown[]>;
  rawWidgetCount(workspaceId: string, tx?: unknown): Promise<unknown>;
  findWidgetsInlineFallback(workspaceId: string, tx?: unknown): Promise<unknown[]>;
};
declare const ghostRepository: { vanished(id: string): Promise<unknown> };
declare const tx: unknown;
declare const workspaceId: string;

export async function callSites(): Promise<void> {
  // in-scope — gated, bindable, no `tx` passed. THE work.
  await fixtureRepository.findWidgets(workspaceId);

  // already-bound — the same method with the `tx` supplied. Nothing to do.
  await fixtureRepository.findWidgets(workspaceId, tx);

  // not-gated — no policy applies, so unbound is correct. DO NOT TOUCH.
  await fixtureRepository.findGlobalSettings();

  // pre-auth — adjudicated actorless by the MOTIR-2784 guard. DO NOT TOUCH.
  await fixtureRepository.countAllUnsafe(workspaceId);

  // needs-binding-first — gated, but there is no `tx` parameter to pass yet.
  await fixtureRepository.findWidgetsUnbindable(workspaceId);

  // in-scope — the MULTI-LINE signature, unbound. The regression `countBacklog`
  // stands for: a single-line matcher calls this `needs-binding-first` and the
  // site is silently dropped from the story.
  await fixtureRepository.findWidgetsWrapped(workspaceId, 10);

  // already-bound — the multi-line signature WITH its `tx`, at the third position,
  // proving the index comes from the signature rather than from argument count.
  await fixtureRepository.findWidgetsWrapped(workspaceId, 10, tx);

  // in-scope — raw SQL is gated (target unknowable), so it must be ruled on.
  await fixtureRepository.rawWidgetCount(workspaceId);

  // already-bound — an explicit `undefined` in the `tx` slot binds NOTHING, so
  // this must NOT be read as bound. It is the sixth shape the naive check misses.
  await fixtureRepository.findWidgets(workspaceId, undefined);

  // not-gated, UNBOUND — the correct state. The do-not-touch floor counts this one.
  await fixtureRepository.findGlobalSettingsBindable();

  // not-gated, BOUND — the VIOLATION the guard exists to catch. Its verdict is
  // still `not-gated`, so only `bound` distinguishes it from the line above.
  await fixtureRepository.findGlobalSettingsBindable(tx);

  // in-scope — the INLINE `(tx ?? db).widget` form (MOTIR-2911). Before the
  // classifier unwrapped the fallback expression this read `not-gated`: the
  // method appeared to address no model at all, so its table's policies were
  // invisible and the site was reported as correct-unbound. It is the shape
  // nearly every bindable repository method in `lib/repositories` is written in.
  await fixtureRepository.findWidgetsInlineFallback(workspaceId);

  // already-bound — the same inline-fallback method WITH its `tx`. Pinned so the
  // fix cannot regress in the other direction (everything gated ⇒ everything red).
  await fixtureRepository.findWidgetsInlineFallback(workspaceId, tx);

  // UNCLASSIFIABLE — no such method in the repository index. Must be reported as
  // unclassifiable and fail the build, never defaulted to `in-scope` (which would
  // send a batch to bind something that does not exist) and never dropped
  // silently (which would hide a renamed method from every future sweep).
  await ghostRepository.vanished('id');
}
