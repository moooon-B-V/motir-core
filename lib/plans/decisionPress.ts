// What a PLAN DECISION PRESS carries over the wire (MOTIR-6038) — shared by the approve
// and decline routes so the two read one shape. The body is OPTIONAL: an empty or
// non-JSON body is a press that was shown no question (a `generating` plan's discard),
// and whether a stamp is REQUIRED is the service's call, made once it knows whether the
// plan's question is asked.

export interface PlanDecisionPress {
  /** The `PlanReviewDto.gate.stamp` the reader was shown, or null. */
  stamp: string | null;
  /** Why — optional on both verbs (ADR §11.4). */
  noteMd: string | null;
}

export async function readPlanDecisionPress(req: Request): Promise<PlanDecisionPress> {
  let body: unknown = null;
  try {
    const text = await req.text();
    body = text.trim() === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const stamp =
    typeof record.stamp === 'string' && record.stamp.trim() !== '' ? record.stamp : null;
  const noteMd =
    typeof record.noteMd === 'string' && record.noteMd.trim() !== '' ? record.noteMd : null;
  return { stamp, noteMd };
}
