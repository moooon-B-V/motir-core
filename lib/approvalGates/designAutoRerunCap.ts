// How many AUTOMATIC hosted re-runs one design card may have (Story MOTIR-693 ·
// MOTIR-700; `docs/decisions/hosted-design-rerun-and-design-approval-switch.md` §1e).
// Its own module so the gate read (MOTIR-702) can say "n of 3" without importing the
// re-run service and everything the hosted start path pulls in.
export const DESIGN_AUTO_RERUN_CAP = 3;
