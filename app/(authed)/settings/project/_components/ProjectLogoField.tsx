'use client';

import { useRef, useState, useTransition, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Camera, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';
import {
  PROJECT_IMAGE_ACCEPT,
  PROJECT_IMAGE_MAX_BYTES,
  isProjectImageType,
} from '@/lib/projects/imageUpload';
import { updateProjectLogoAction } from '../actions';

// The project's LOGO row on Project settings › Details (MOTIR-2678), per
// `design/projects/details.mock.html` panel 2. Composed from the shipped Account
// › Profile Photo row's grammar (`AvatarField`) one entity over: the picture,
// a Change control, and a Remove control that appears only when there is
// something to remove, behind a confirm.
//
// ⚠️ THE ROW CARRIES NO LABEL, and that is the design, not an omission (Yue,
// 2026-08-11): a label reading "Image" above a picture of the project's logo
// says nothing the picture has not already said. The row leads with the logo.
// The word survives in exactly the two states where there IS no picture to speak
// for itself — the empty state's button ("Upload logo") and the remove confirm
// ("Remove project logo?") — and nowhere else, because everywhere else the
// controls sit beside the thing they act on.
//
// ⚠️ AND WHEN THERE IS NO LOGO, NOTHING RENDERS. No placeholder box, no dashed
// outline, no monogram, no generated tint (`docs/decisions/entity-marks.md` §3).
// The empty state is the ABSENCE of the box, not a styled version of it — the
// row collapses to its Upload button. This is the visible half of the stance and
// the single thing most likely to be softened by a well-meant later commit.
//
// Backend wiring (the account row's, one entity over): "Change" POSTs the file to
// `/api/upload/project-image` (multipart, returns `{ key }` — the object KEY),
// then calls `updateProjectLogoAction(key)` to persist it; "Remove" calls the
// same action with `null`. We never render the key: the action returns the
// RESOLVED absolute URL, which is what `setLogo` stores.
//
// Page-state contract (CLAUDE.md): this is a client island holding its own
// optimistic value, so on success we KEEP it here AND call `router.refresh()` —
// the OTHER surfaces that show the mark (the top bar's project tier, the
// settings-area rail header) are SERVER-rendered and re-read the project.
// `router.refresh()` cannot reach this island's `useState`, so the optimistic
// value is safe.

export interface ProjectLogoFieldProps {
  /** The resolved absolute URL, or null when the project has no logo. */
  initialLogo: string | null;
  /** The project's KEY — the upload route resolves it and gates on manage. */
  projectIdentifier: string;
  /** Disables the controls while the card's own save bar is in flight. */
  disabled?: boolean;
}

export function ProjectLogoField({
  initialLogo,
  projectIdentifier,
  disabled = false,
}: ProjectLogoFieldProps) {
  const t = useTranslations('settings.details.logo');
  const router = useRouter();
  const { toast } = useToast();

  const [logo, setLogo] = useState<string | null>(initialLogo);
  const [isUploading, setIsUploading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isRemoving, startRemove] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = isUploading || isRemoving || disabled;

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the input so picking the SAME file again still fires onChange.
    event.target.value = '';
    if (!file) return;

    // Pre-validate against the SAME constants the upload route enforces, so the
    // message a person sees can never state a limit the server does not keep.
    if (!isProjectImageType(file.type)) {
      toast({ variant: 'error', title: t('errors.invalidType') });
      return;
    }
    if (file.size > PROJECT_IMAGE_MAX_BYTES) {
      toast({ variant: 'error', title: t('errors.tooLarge') });
      return;
    }

    setIsUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('projectKey', projectIdentifier);
      const res = await fetch('/api/upload/project-image', { method: 'POST', body: form });
      if (!res.ok) {
        toast({ variant: 'error', title: t('errors.failed') });
        return;
      }
      const { key } = (await res.json()) as { key: string };

      const result = await updateProjectLogoAction(key);
      if (!result.ok) {
        toast({ variant: 'error', title: t('errors.failed') });
        return;
      }

      // A failed change never blanks the row — we only move off the old value
      // once the persist has succeeded.
      setLogo(result.image);
      toast({ variant: 'success', title: t('updated') });
      router.refresh();
    } catch {
      toast({ variant: 'error', title: t('errors.failed') });
    } finally {
      setIsUploading(false);
    }
  }

  function confirmRemove() {
    startRemove(async () => {
      const result = await updateProjectLogoAction(null);
      if (!result.ok) {
        toast({ variant: 'error', title: t('errors.failed') });
        return;
      }
      setLogo(null);
      setConfirmOpen(false);
      toast({ variant: 'success', title: t('removed') });
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      {/* No logo ⇒ NOTHING renders here. Not an empty box — no box. */}
      {logo ? (
        <span
          className={cn(
            'inline-flex h-[52px] w-[52px] flex-none items-center justify-center',
            'overflow-hidden rounded-(--radius-control)',
          )}
        >
          {/* A user-uploaded asset on an external host with no known dimensions;
              next/image adds nothing here (the same call AvatarField makes). */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo} alt={t('alt')} className="h-full w-full object-cover" />
        </span>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept={PROJECT_IMAGE_ACCEPT}
        className="hidden"
        onChange={onFileChange}
        data-testid="project-logo-input"
      />
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<Camera className="h-3.5 w-3.5" aria-hidden />}
        onClick={pickFile}
        loading={isUploading}
        disabled={busy}
      >
        {/* The one place the noun is load-bearing: with no picture beside it, a
            bare "Upload" reads as "upload what?". */}
        {logo ? t('change') : t('upload')}
      </Button>
      {logo ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-(--el-danger) hover:bg-(--el-tint-rose)"
          leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
          onClick={() => setConfirmOpen(true)}
          disabled={busy}
        >
          {t('remove')}
        </Button>
      ) : null}

      <Modal
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!isRemoving) setConfirmOpen(open);
        }}
        title={t('removeConfirm.title')}
        description={t('removeConfirm.body')}
        size="sm"
        role="alertdialog"
      >
        <Modal.Footer>
          <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={isRemoving}>
            {t('removeConfirm.cancel')}
          </Button>
          <Button variant="danger" onClick={confirmRemove} loading={isRemoving}>
            {t('removeConfirm.confirm')}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}
