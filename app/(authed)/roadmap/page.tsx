import { memberPageContext } from '@/lib/pages/projectPageContext';
import RoadmapPageView from './_view';

// The roadmap for a MEMBER — the body is `RoadmapPageView`, handed the member's page
// context (MOTIR-6643).
export default async function RoadmapPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
  // Defaulted, so the page's own guard file (`tests/planning/roadmapPageStreaming`)
  // keeps calling it with no arguments.
} = {}) {
  const ctx = await memberPageContext();
  // Called, not mounted: the view IS this page's body, so a caller of the page
  // (a test included) runs it exactly as it ran before the move.
  return RoadmapPageView({ ctx, searchParams });
}
