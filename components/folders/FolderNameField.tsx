'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { FOLDER_NAME_MAX_LENGTH } from '@/lib/folders/errors';
import { cn } from '@/lib/utils/cn';

// The INLINE folder name row (Story MOTIR-5308 · MOTIR-5344), the design's panel
// 3 — one field for both a new folder and a rename. Enter saves, Escape cancels;
// a refusal keeps the field open with the reason beside it.
//
// ⚠️ ONE DELIBERATE DEPARTURE FROM THE MOCK. Panel 3 stacks the reason UNDER the
// input in a taller row. The tree's rows are a fixed 40px because the treegrid
// WINDOWS by row height (TreeTable's `ROW_PX`), and a taller row would put every
// row below it at the wrong offset. So the hint or the reason sits BESIDE the
// input on the same 40px row, with the same tokens the mock names.
//
// Keys and clicks stop at the input: the row's own handlers treat arrows as row
// focus moves and Enter as "toggle this folder".

export interface FolderNameFieldProps {
  initialName: string;
  /** The refusal to show, or `null`. Non-null marks the input `aria-invalid`. */
  error: string | null;
  pending: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  /** The person typed — a shown refusal no longer describes the value. */
  onEdit: () => void;
}

export function FolderNameField({
  initialName,
  error,
  pending,
  onSubmit,
  onCancel,
  onEdit,
}: FolderNameFieldProps) {
  const t = useTranslations('folders');
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);
  const messageId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div
        className={cn(
          'w-full max-w-[280px] shrink-0',
          error && '[&_[data-surface=input]]:border-(--el-danger)',
        )}
      >
        <Input
          ref={inputRef}
          aria-label={t('nameLabel')}
          aria-invalid={error ? true : undefined}
          aria-describedby={messageId}
          maxLength={FOLDER_NAME_MAX_LENGTH}
          value={value}
          readOnly={pending}
          className="font-semibold"
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            setValue(e.target.value);
            onEdit();
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              if (!pending) onSubmit(value);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
        />
      </div>
      {error ? (
        <span
          id={messageId}
          role="alert"
          className="flex min-w-0 items-center gap-1.5 text-xs text-(--el-text)"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-(--el-danger)" aria-hidden />
          <span className="truncate">{error}</span>
        </span>
      ) : (
        <span id={messageId} className="min-w-0 truncate text-xs text-(--el-text-secondary)">
          {t('nameHint')}
        </span>
      )}
    </div>
  );
}
