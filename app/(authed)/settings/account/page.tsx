import { redirect } from 'next/navigation';

// The account-settings AREA root (Story 7.8 · Subtask 7.8.12). The flat 2-card
// page became a grouped-nav area (the rail-swap nav), so the root no longer
// renders content — it redirects to the first real pane (Language), mirroring the
// way a Jira/Linear settings area lands on its first section. Every real surface
// lives under its own route (`/settings/account/language`, `/notifications`); the
// reserved Profile / Appearance / API-tokens slots are "Soon" rows in the rail
// until their own stories ship. (Excluded from the route↔registry totality test —
// it is a redirect, not a nav destination.)
export default function AccountSettingsRedirectPage() {
  redirect('/settings/account/language');
}
