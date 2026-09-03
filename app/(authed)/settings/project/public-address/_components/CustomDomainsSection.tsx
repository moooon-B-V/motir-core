/**
 * The customer-domain half of the Public address room — MOTIR-4229's, and a
 * TYPED STUB until it lands.
 *
 * ⚠️ IT RENDERS NOTHING, ON PURPOSE, AND THE FILE EXISTS ANYWAY. MOTIR-4221's
 * card asks for the slot so that part 2 is an ADDITION rather than an edit: the
 * page already imports it, composes it and passes it the two values it will
 * need, so the second card changes this file and nothing else. A slot invented
 * later is a slot whose props are guessed by whoever needs it least.
 *
 * The props are the ones the design's panels 3–7 require and no more: the
 * project whose domains these are, and whether the actor may change them.
 * `canManage` is passed `false` by the page today — part 2 resolves it from the
 * same project permission the rail row is gated on (`project:manage_access`),
 * which is a DIFFERENT axis from the subdomain card's workspace role.
 */
export function CustomDomainsSection(_props: {
  projectKey: string;
  canManage: boolean;
}): React.ReactNode {
  return null;
}
