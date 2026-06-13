// Per-user notification preference gate (Story 5.7).
//
// ⚠️ SEAM — this is the CALL SITE only (Subtask 5.7.3). Subtask 5.7.6 lands the
// real `NotificationPreference` model + the row-or-default resolver BEHIND this
// signature, and wires the DONE 5.1.6 email job to consult it too — so toggling
// a channel off in `/settings/account` actually suppresses that channel. The
// signature below IS the contract every consumer codes against; 5.7.3 ships it
// with a PERMISSIVE DEFAULT (everything enabled — the documented direct/mention
// default) so the in-app fan-in (5.7.3) has a gate to consult before 5.7.6
// exists. Do NOT inline the gate at the call sites; keep it behind this resolver
// so 5.7.6 replaces ONE body, not N.
//
// 4-layer note: once 5.7.6 backs this with a model it becomes a SERVICE proper
// (it'll own the per-user × event-type × channel resolution over the
// `notificationPreferenceRepository`). Today it is a pure function with no I/O —
// the minimal seam, nothing speculative (anti-overplanning, notes #20).

/** The two delivery channels a notification preference gates (Story 5.7.6). */
export type NotificationChannel = 'email' | 'in_app';

export const notificationPreferencesService = {
  /**
   * Whether `userId` wants `eventType` notifications delivered on `channel`.
   *
   * The single CHANNEL GATE both the 5.7.3 in-app fan-in (`'in_app'`) and the
   * DONE 5.1.6 email job (`'email'`, wired in 5.7.6) consult before
   * writing/sending. Until 5.7.6 lands the preference model, this resolves to
   * the permissive default (enabled) for every (user, event, channel) — an
   * unset preference is "on" for direct/mention events, which is exactly the
   * documented default, so the default-on stub matches the eventual resolver's
   * behaviour for the events 5.7.3 ships.
   */
  async isChannelEnabled(
    _userId: string,
    _eventType: string,
    _channel: NotificationChannel,
  ): Promise<boolean> {
    return true;
  },
};
