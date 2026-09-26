import { act, fireEvent, screen, within } from '@testing-library/react';
import en from '@/messages/en.json';

// A REFUSAL SAYS WHY (Story MOTIR-6067 · MOTIR-6075; ADR `approval-gates.md` §10a). Every
// refusal verb now OPENS the confirm band and asks for a reason, so a spec that used to
// click *Request changes* and assert the decision presses THREE things: the verb, the
// reason field, and the band's proceed button. One helper, so every spec presses it the
// same way the reader does.
//
// A DESIGN sent back also takes a VERDICT (Story MOTIR-6070 · MOTIR-6427): when the band
// draws the Revise / Re-plan group, the helper picks `verdict` (Revise unless told
// otherwise) — a spec about the verdict itself presses the tiles by hand.

type Messages = typeof en;
type Scope = typeof screen | ReturnType<typeof within>;

export async function refuseWithReason(
  opts: {
    scope?: Scope;
    messages?: Messages;
    /** `choice` for *None of these*; the default is *Request changes*. */
    verb?: 'requestChanges' | 'choice';
    reason?: string;
    /** Which verdict to pick when the band asks for one (a design). Default `revise`. */
    verdict?: 'revise' | 're_plan';
  } = {},
): Promise<void> {
  const scope = opts.scope ?? screen;
  const m = opts.messages ?? en;
  const choice = opts.verb === 'choice';
  const verbName = choice
    ? m.approvalGate.choice.verb.noneOfThese
    : m.approvalGate.verb.requestChanges;
  const words = choice ? m.approvalGate.reason.choice : m.approvalGate.reason;
  await act(async () => {
    fireEvent.click(scope.getAllByRole('button', { name: verbName })[0]!);
  });
  fireEvent.change(scope.getByLabelText(words.label), {
    target: { value: opts.reason ?? 'Needs changes.' },
  });
  const verdicts = scope.queryByRole('radiogroup', { name: m.approvalGate.reason.verdict.legend });
  if (verdicts) {
    const label =
      opts.verdict === 're_plan'
        ? m.approvalGate.reason.verdict.replan.label
        : m.approvalGate.reason.verdict.revise.label;
    fireEvent.click(within(verdicts).getByRole('radio', { name: new RegExp(`^${label}`) }));
  }
  await act(async () => {
    fireEvent.click(scope.getByRole('button', { name: words.proceed }));
  });
}
