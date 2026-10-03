import type { ReactNode } from 'react';
import { Snowflake } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';

// THE FROZEN CHIP (Story MOTIR-5761 · MOTIR-7436 / MOTIR-7444; `decision-port--page`,
// `confirm-port--page-record` and `page--history-frozen` mocks): a page version an
// approval FROZE. The sky tint and the snowflake are the one frozen mark, drawn the same
// in the decision port, the confirm port's band and the History panel.
export function FrozenPill({ children }: { children: ReactNode }) {
  return (
    <Pill severity="info" className="gap-1">
      <Snowflake className="h-3 w-3 flex-none" aria-hidden />
      {children}
    </Pill>
  );
}
