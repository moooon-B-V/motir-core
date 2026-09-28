// The VISITOR RECORD on the wire (Story MOTIR-6170 · MOTIR-6666 / MOTIR-6667 /
// MOTIR-6668; `docs/decisions/visitor-sign-in-and-records.md`).

/** The reader's own consent, as `visitorRecordsService.recordConsent` answers it. */
export interface VisitorConsentDTO {
  projectIdentifier: string;
  consentedAt: string;
  firstVisitAt: string;
  lastVisitAt: string;
}

/**
 * One row of a public project's Visitors list, for its Managers (MOTIR-6667) —
 * the one payload that carries a Visitor's email, and exactly what the person
 * was told on the consent screen would be shared: their name, their email, and
 * when they visited and agreed. No user id and no avatar.
 *
 * `name` is the person's own display name and may be empty; the list draws the
 * neutral `common.personFallback` label for an empty one, with the email beside
 * it.
 */
export interface ProjectVisitorDTO {
  name: string;
  email: string;
  firstVisitAt: string;
  lastVisitAt: string;
  consentedAt: string;
}

/** One page of the Visitors list: its rows, the whole list's size, and the next page's cursor. */
export interface ProjectVisitorsPageDTO {
  visitors: ProjectVisitorDTO[];
  total: number;
  nextCursor: string | null;
}
