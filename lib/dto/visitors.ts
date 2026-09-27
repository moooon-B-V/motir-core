// The VISITOR RECORD on the wire (Story MOTIR-6170 · MOTIR-6666 / MOTIR-6667 /
// MOTIR-6668; `docs/decisions/visitor-sign-in-and-records.md`).

/** The reader's own consent, as `visitorRecordsService.recordConsent` answers it. */
export interface VisitorConsentDTO {
  projectIdentifier: string;
  consentedAt: string;
  firstVisitAt: string;
  lastVisitAt: string;
}
