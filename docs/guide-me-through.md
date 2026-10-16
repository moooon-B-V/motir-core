# Guide me through

**Guide me through** is Motir AI walking you through a manual work item, step by
step, in the planning overlay. The card's to-do list is on the left, the
conversation is on the right, and each step is ticked as you finish it. A stale
step is fixed in place; the guide rewrites it and says so.

## When the work item itself is wrong

Sometimes the problem is not a step but the work item: what it asks for no longer
makes sense, or the thing it depends on has changed. The guide then says plainly
that it **can't guide you any further**, and ends its reply with a **re-plan
offer** instead of a next step.

The offer shows:

- **Re-plan request** — the request the guide wrote for you: the work item, what
  is wrong, what you found, and the steps you had already ticked. Long requests
  are clamped; press **Show all** to read the whole thing.
- **The target** — the work item the re-plan would start on. It is usually the
  card you are on. The guide may aim higher, at the card's parent, when the
  problem sits there. If the card it picked is already done, the offer starts
  from the nearest open work item above it and says so. If every card above is
  done, there is nothing open to re-plan from, and the offer has no **Confirm**.

You can still talk to the guide while the offer is open. Ask it to change the
request or aim at the parent, and it answers with a **new** offer; the earlier one
reads **Replaced by a newer offer** and loses its buttons. Only the latest offer
can be confirmed or declined.

### Confirm

**Confirm opens Motir AI planning on the target with the request already sent.**
You do not retype it. Motir AI answers at once. **Confirm spends credits**, the
same as any planning turn, and says so under the button. If you are out of
credits, the paywall appears in place of planning and nothing starts; the offer
stays open.

While the re-plan is open, the guided card is held at **Planning**, as it is for
any plan in progress.

### Decline

**Decline closes the offer.** Nothing is planned and no credits are spent. The
offer reads **Declined**, who declined and when, and the guide's note on the card
stays. Open **Guide me through** again and it picks up at the first step you have
not ticked.

### Coming back

Every state is stored with the conversation, so a reload shows what you decided.
After you confirm, the offer reads **Re-plan started** with a link, **Open the
planning session**. Pressing it returns to the same session and sends nothing
again. The session is also on the **Plans** page.

### If you can't start planning

If Motir AI isn't set up for the project, or you can't plan here, the offer is
still shown in full with a line saying why, so you can share the request with
someone who can. **Decline** is always available.
