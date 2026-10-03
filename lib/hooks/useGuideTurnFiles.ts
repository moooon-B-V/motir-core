'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES } from '@/lib/blob/allowlist';
import type { EntitlementKind } from '@/lib/billing/entitlements';
import { GUIDE_FILES_MAX } from '@/lib/ai/guideFiles';
import { postWorkItemAttachment, UPLOAD_ABORTED, UploadFailure } from '@/lib/blob/uploadClient';

// THE FILES OF THE TURN BEING WRITTEN (Story MOTIR-7471 · MOTIR-7486; design
// MOTIR-7482 `planning-workspace--guide-files.mock.html` panels 2–7;
// `docs/decisions/guide-turn-files.md` A3.1 / A3.3).
//
// Queued files are LOCAL until Send: `upload()` attaches each to the guided card
// through the shipped `POST /api/work-items/{id}/attachments` (the item page's
// upload, `source: 'panel'`), in the order they were added, and resolves to the
// attachment ids the turn then carries. Any failure resolves null — the turn is
// not sent — and a file already on the card keeps its id, so the next Send
// uploads only what failed (A3.1: "not uploaded twice").
//
// The pre-check is the item page's, against the SAME shared policy the server
// enforces (`lib/blob/allowlist.ts`), plus the turn's cap of four (A3.3). A
// refused file never joins the queue; it is reported as a refusal row.

export type GuideQueuedFileStatus = 'waiting' | 'uploading' | 'done' | 'failed';

export interface GuideQueuedFile {
  key: number;
  file: File;
  name: string;
  mime: string;
  sizeBytes: number;
  status: GuideQueuedFileStatus;
  /** 0–100 while uploading when the request reports progress; null otherwise. */
  pct: number | null;
  /** The attachment on the card, once uploaded. */
  attachmentId: string | null;
  /** A local object URL for an image's thumbnail; null for any other file. */
  previewUrl: string | null;
}

/** Why a file did not join the queue, or was taken out of it by the server. */
export interface GuideFileRefusal {
  key: number;
  name: string;
  /** `CAP` is the turn's cap of four; the rest are the upload route's codes. */
  code: 'CAP' | string | undefined;
  entitlement?: EntitlementKind;
}

/** A refusal the server gave that a retry cannot fix: the file leaves the queue. */
const PERMANENT_CODES = new Set(['FILE_TOO_LARGE', 'UNSUPPORTED_FILE_TYPE']);

function objectUrlFor(file: File): string | null {
  if (!file.type.startsWith('image/')) return null;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  return URL.createObjectURL(file);
}

function revoke(url: string | null): void {
  if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

export function useGuideTurnFiles(workItemId: string) {
  const [files, setFiles] = useState<GuideQueuedFile[]>([]);
  const [refusals, setRefusals] = useState<GuideFileRefusal[]>([]);
  const [uploading, setUploading] = useState(false);
  const [notSent, setNotSent] = useState(false);
  // The queue as the upload loop reads it — state updates inside the loop do
  // not reach a closure taken at its start.
  const filesRef = useRef<GuideQueuedFile[]>([]);
  const seqRef = useRef(0);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const stoppedRef = useRef(false);

  const commit = useCallback((next: GuideQueuedFile[]) => {
    filesRef.current = next;
    setFiles(next);
  }, []);

  const patch = useCallback(
    (key: number, change: Partial<GuideQueuedFile>) => {
      commit(filesRef.current.map((f) => (f.key === key ? { ...f, ...change } : f)));
    },
    [commit],
  );

  // Object URLs outlive nothing: release them when the rail goes away.
  useEffect(
    () => () => {
      for (const f of filesRef.current) revoke(f.previewUrl);
    },
    [],
  );

  /** Queue files — attach, paste and drop all arrive here. */
  const add = useCallback(
    (incoming: readonly File[]) => {
      const queued = [...filesRef.current];
      const refused: GuideFileRefusal[] = [];
      for (const file of incoming) {
        seqRef.current += 1;
        const key = seqRef.current;
        const code =
          queued.length >= GUIDE_FILES_MAX
            ? 'CAP'
            : file.size > MAX_UPLOAD_BYTES
              ? 'FILE_TOO_LARGE'
              : !ALLOWED_UPLOAD_TYPES.includes(file.type)
                ? 'UNSUPPORTED_FILE_TYPE'
                : null;
        if (code) {
          refused.push({ key, name: file.name, code });
          continue;
        }
        queued.push({
          key,
          file,
          name: file.name,
          mime: file.type,
          sizeBytes: file.size,
          status: 'waiting',
          pct: null,
          attachmentId: null,
          previewUrl: objectUrlFor(file),
        });
      }
      commit(queued);
      if (refused.length > 0) setRefusals((current) => [...current, ...refused]);
    },
    [commit],
  );

  /** Take a file out of the turn. One already on the card STAYS on the card. */
  const remove = useCallback(
    (key: number) => {
      const gone = filesRef.current.find((f) => f.key === key);
      revoke(gone?.previewUrl ?? null);
      const next = filesRef.current.filter((f) => f.key !== key);
      commit(next);
      if (!next.some((f) => f.status === 'failed')) setNotSent(false);
    },
    [commit],
  );

  const dismissRefusal = useCallback((key: number) => {
    setRefusals((current) => current.filter((r) => r.key !== key));
  }, []);

  /**
   * Attach every queued file not yet on the card, in order. Resolves the turn's
   * attachment ids, or null when the turn must not be sent: a file failed (it is
   * marked, and `notSent` says so), or the person pressed Stop.
   */
  const upload = useCallback(async (): Promise<string[] | null> => {
    stoppedRef.current = false;
    setUploading(true);
    setNotSent(false);
    let failed = false;
    try {
      for (const queued of filesRef.current) {
        if (stoppedRef.current) break;
        if (queued.status === 'done') continue;
        patch(queued.key, { status: 'uploading', pct: null });
        try {
          const attachment = await postWorkItemAttachment(
            workItemId,
            queued.file,
            (pct) => patch(queued.key, { pct }),
            (xhr) => {
              xhrRef.current = xhr;
            },
          );
          patch(queued.key, { status: 'done', pct: 100, attachmentId: attachment.id });
        } catch (err) {
          const failure = err instanceof UploadFailure ? err : new UploadFailure();
          if (failure.code === UPLOAD_ABORTED) {
            patch(queued.key, { status: 'waiting', pct: null });
            break;
          }
          if (failure.entitlement || (failure.code && PERMANENT_CODES.has(failure.code))) {
            // Not transient: the file leaves the turn with the shipped message.
            revoke(queued.previewUrl);
            commit(filesRef.current.filter((f) => f.key !== queued.key));
            setRefusals((current) => [
              ...current,
              {
                key: queued.key,
                name: queued.name,
                code: failure.code,
                ...(failure.entitlement ? { entitlement: failure.entitlement } : {}),
              },
            ]);
          } else {
            patch(queued.key, { status: 'failed', pct: null });
          }
          failed = true;
        } finally {
          xhrRef.current = null;
        }
      }
    } finally {
      setUploading(false);
    }
    if (failed) {
      setNotSent(true);
      return null;
    }
    if (stoppedRef.current) return null;
    return filesRef.current.map((f) => f.attachmentId as string);
  }, [commit, patch, workItemId]);

  /** Stop the send: the upload in flight is cancelled and the turn is not sent. */
  const stop = useCallback(() => {
    stoppedRef.current = true;
    xhrRef.current?.abort();
  }, []);

  /** The turn was sent: the tray empties. */
  const reset = useCallback(() => {
    for (const f of filesRef.current) revoke(f.previewUrl);
    commit([]);
    setRefusals([]);
    setNotSent(false);
  }, [commit]);

  return { files, refusals, uploading, notSent, add, remove, dismissRefusal, upload, stop, reset };
}
