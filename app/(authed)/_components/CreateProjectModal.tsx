'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { createProjectAction } from '../_project-actions';

// Client-side mirror of projectsService.deriveIdentifierBase so the LIVE
// KEY PREVIEW reflects what the server will actually persist. If these
// drift the preview lies — keep them in sync (the service is the source
// of truth; this just shadows it for instant feedback).
const IDENTIFIER_MIN = 3;
const IDENTIFIER_MAX = 5;
const IDENTIFIER_FALLBACK = 'PRJ';

function deriveIdentifierFromName(name: string): string {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length === 0) return '';
  return cleaned.slice(0, IDENTIFIER_MAX).padEnd(IDENTIFIER_MIN, 'X');
}

function normalizeIdentifierInput(raw: string): string {
  // Match the service's normalize: uppercase + strip non-alphanumeric.
  // Don't pad here — let the user type freely; pad only at the boundary
  // (the helperText preview) so the field reflects exactly what they typed.
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, IDENTIFIER_MAX);
}

export interface CreateProjectModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateProjectModal({ open, onOpenChange }: CreateProjectModalProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [isIdentifierDirty, setIsIdentifierDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Reset state on close — done in the onOpenChange wrapper rather than a
  // useEffect (React 19's react-hooks/set-state-in-effect lint rule
  // disallows the latter; the existing workspace DeleteConfirmModal uses
  // this pattern too).
  function handleOpenChange(next: boolean) {
    if (!next) {
      setName('');
      setIdentifier('');
      setIsIdentifierDirty(false);
      setError(null);
    }
    onOpenChange(next);
  }

  const derivedIdentifier = deriveIdentifierFromName(name);
  const effectiveIdentifier = isIdentifierDirty ? identifier : derivedIdentifier;
  // What the live preview shows; pad short user-typed identifiers to the
  // 3-char minimum so the previewed key matches the server-normalized
  // value the row will store.
  const previewIdentifier =
    effectiveIdentifier.length === 0
      ? IDENTIFIER_FALLBACK
      : effectiveIdentifier.padEnd(IDENTIFIER_MIN, 'X');

  function handleNameChange(value: string) {
    setName(value);
  }

  function handleIdentifierChange(value: string) {
    setIdentifier(normalizeIdentifierInput(value));
    setIsIdentifierDirty(true);
  }

  function handleSubmit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      try {
        await createProjectAction({
          name: trimmed,
          identifier: isIdentifierDirty && identifier ? identifier : undefined,
        });
        handleOpenChange(false);
        toast({ variant: 'success', title: 'Project created' });
        router.refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not create project';
        // The service throws IdentifierCollisionError after exhausting
        // retries — surface that on the identifier field so the user can
        // pick a different one. Other errors surface as a toast.
        if (message.includes('IDENTIFIER_COLLISION')) {
          setError('That identifier is already taken. Try a different one.');
        } else {
          toast({ variant: 'error', title: 'Could not create project' });
        }
      }
    });
  }

  return (
    <Modal open={open} onOpenChange={handleOpenChange} title="Create project" size="md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <div className="space-y-(--spacing-md)">
          <Input
            label="Project name"
            placeholder="Mobile App"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            autoFocus
            disabled={isPending}
          />
          <Input
            label="Identifier"
            value={effectiveIdentifier}
            onChange={(e) => handleIdentifierChange(e.target.value)}
            className="font-mono uppercase"
            maxLength={IDENTIFIER_MAX}
            error={error ?? undefined}
            helperText={
              error
                ? undefined
                : `3–5 uppercase characters. Work items will be keyed ${previewIdentifier}-1, ${previewIdentifier}-2, …`
            }
            disabled={isPending}
          />
        </div>
        <Modal.Footer>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={isPending} disabled={!name.trim()}>
            Create project
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
