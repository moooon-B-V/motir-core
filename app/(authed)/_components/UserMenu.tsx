'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Settings } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import { signOut } from '@/lib/auth/client';

export interface UserMenuProps {
  name: string;
  email: string;
}

export function UserMenu({ name, email }: UserMenuProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const initial = (name || email).trim().charAt(0).toUpperCase() || '?';

  function handleSignOut() {
    startTransition(async () => {
      await signOut();
      // Drop the in-memory router cache and bounce to sign-in; the proxy
      // would redirect anyway once the session cookie is gone.
      router.push('/sign-in');
      router.refresh();
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="bg-(--el-text) text-(--el-text-inverted) focus-visible:ring-(--focus-ring-color) inline-flex h-9 w-9 items-center justify-center rounded-full font-sans text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {initial}
        </button>
      </Popover.Trigger>
      <Popover.Content align="end" width={240} className="py-1">
        <div className="border-(--el-border) mb-1 border-b px-3 pb-2 pt-2">
          <p className="truncate font-sans text-sm font-medium text-(--el-text)">{name || email}</p>
          {name ? (
            <p className="text-(--el-text-muted) truncate font-sans text-xs">{email}</p>
          ) : null}
        </div>
        <div className="px-1">
          <a
            href="/settings/workspace"
            onClick={() => setOpen(false)}
            className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-2 text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
          >
            <Settings className="text-(--el-text-muted) h-4 w-4" aria-hidden />
            Workspace settings
          </a>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={isPending}
            className={cn(
              'hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-2 text-left font-sans text-sm text-(--el-text) focus-visible:outline-none',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <LogOut className="text-(--el-text-muted) h-4 w-4" aria-hidden />
            {isPending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </Popover.Content>
    </Popover>
  );
}
