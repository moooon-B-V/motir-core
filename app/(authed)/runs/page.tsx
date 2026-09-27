import { memberPageContext } from '@/lib/pages/projectPageContext';
import RunsView from './_view';

// The Runs room for a MEMBER — the body is `RunsView`, handed the member's page
// context (MOTIR-6643).
export default async function RunsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const ctx = await memberPageContext();
  // Called, not mounted: the view IS this page's body, so a caller of the page
  // (a test included) runs it exactly as it ran before the move.
  return RunsView({ ctx, searchParams });
}
