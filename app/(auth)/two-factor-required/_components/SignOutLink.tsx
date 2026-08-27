'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { signOut } from '@/lib/auth/client';

// The way OUT of the forced-enrolment screen (Story MOTIR-1215 · MOTIR-3648).
//
// ⚠️ MANDATORY, NOT DECORATIVE. Every other route is closed to a held visitor,
// so a screen with no exit is a trap — somebody on a borrowed laptop, without
// their phone, or who simply does not want to do this right now must be able to
// leave rather than bounce between a redirect and a screen they cannot satisfy.
// `design/auth/two-factor-required.mock.html` gives this its own panel for
// exactly that reason.
//
// A ghost Button: present on the screen, never competing with enrolment.
export function SignOutLink({ label }: { label: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={<LogOut className="h-4 w-4" aria-hidden />}
      loading={isPending}
      onClick={() =>
        startTransition(async () => {
          await signOut();
          router.push('/sign-in');
        })
      }
    >
      {label}
    </Button>
  );
}
