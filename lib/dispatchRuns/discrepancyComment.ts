// The card comment a run's discrepancy record leaves (Story MOTIR-8651 · MOTIR-8655,
// decision page MOTIR-8654). PURE: points in, markdown out — no I/O, no clock.
//
// The comment is the record's TEXT. The `discrepancy_recorded` finding on the run carries
// only a pointer to it, so a customer's words stay in the card's own tenant.

/** One point of a discrepancy: what the plan asked · what was built · why. */
export interface RunDiscrepancyPoint {
  planAsked: string;
  built: string;
  why: string;
}

/** Compose the comment body — one numbered block per point, in the order given. */
export function composeDiscrepancyComment(points: readonly RunDiscrepancyPoint[]): string {
  const lines: string[] = [
    `**Built through a plan that was wrong about the HOW** — ${points.length} ` +
      `${points.length === 1 ? 'discrepancy' : 'discrepancies'}. The card's outcome and ` +
      'acceptance criteria were met; the route to them differs from the plan.',
    '',
  ];
  points.forEach((point, index) => {
    lines.push(
      `**${index + 1}.**`,
      `- **Plan asked:** ${point.planAsked}`,
      `- **Built:** ${point.built}`,
      `- **Why:** ${point.why}`,
      '',
    );
  });
  return lines.join('\n').trimEnd();
}
