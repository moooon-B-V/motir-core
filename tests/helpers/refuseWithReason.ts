import { act, fireEvent, screen, within } from '@testing-library/react';
import en from '@/messages/en.json';

// A REFUSAL SAYS WHY (Story MOTIR-6067 · MOTIR-6075; ADR `approval-gates.md` §10a). Every
// refusal verb now OPENS the confirm band and asks for a reason, so a spec that used to
// click *Request changes* and assert the decision presses THREE things: the verb, the
// reason field, and the band's proceed button. One helper, so every spec presses it the
// same way the reader does.

type Messages = typeof en;
type Scope = typeof screen | ReturnType<typeof within>;

export async function refuseWithReason(
  opts: {
    scope?: Scope;
    messages?: Messages;
    /** `choice` for *None of these*; the default is *Request changes*. */
    verb?: 'requestChanges' | 'choice';
    reason?: string;
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
  await act(async () => {
    fireEvent.click(scope.getByRole('button', { name: words.proceed }));
  });
}
