import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// THE EXPORT-READY NOTIFICATION (Story 8.4 · Subtask MOTIR-3703) — the template
// itself, and the post-commit send that dispatches it.
//
// ⚠️ THE ASSERTION THAT MATTERS MOST IS A NEGATIVE ONE: this email carries NO
// link to the file. A presigned URL lives 300 seconds and would be expired
// before most people open their inbox, so mailing one is a design the storage
// layer cannot implement (design DECISION 2). The rendered bodies are therefore
// GREPPED for a signed URL rather than merely inspected for the pane link — a
// template that added a download button and kept the pane one would pass every
// positive assertion.
//
// The send is a POST-COMMIT SIDE EFFECT, which is the other half: a provider
// hiccup must not turn a built archive into a `failed` one.

// ── the blob store, in memory ─────────────────────────────────────────────
// `lib/blob/uploader` is the network seam; its own header says tests mock THIS
// module so nothing hits S3.
const blobs = new Map<string, Buffer>();
vi.mock('@/lib/blob/uploader', () => ({
  putPrivateAttachment: vi.fn(async (pathname: string, body: Buffer) => {
    blobs.set(pathname, Buffer.from(body));
    return { pathname };
  }),
  putPublicAsset: vi.fn(),
  putAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  mintPrivateUploadToken: vi.fn(),
  getPrivateBlobBytes: vi.fn(async (pathname: string) => blobs.get(pathname) ?? null),
  deleteAttachmentBlob: vi.fn(async (pathname: string) => void blobs.delete(pathname)),
  headPrivateBlob: vi.fn(),
}));

// ── the event bus ─────────────────────────────────────────────────────────
interface Emitted {
  name: string;
  data: Record<string, unknown>;
}
const emitted: Emitted[] = [];
const sendEventImpl = {
  current: async (name: string, data: Record<string, unknown>) => {
    emitted.push({ name, data });
  },
};
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: (name: string, data: Record<string, unknown>) => sendEventImpl.current(name, data),
}));

const { db } = await import('@/lib/db');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { dataExportService } = await import('@/lib/services/dataExportService');
const { dataExportReadyEmail } = await import('@/lib/emailTemplates/dataExportReady');
const { DATA_EXPORT_RETENTION_DAYS, DATA_PRIVACY_PANE_PATH } =
  await import('@/lib/users/dataSubjectRequests');
const { locales } = await import('@/lib/i18n/locales');

const PANE_URL = `https://motir.test${DATA_PRIVACY_PANE_PATH}`;

/** Every shape a link to the FILE could take, in one place. */
function assertCarriesNoFileLink(body: string) {
  // A presigned grant, in either of the two forms one is recognisable by.
  expect(body).not.toContain('X-Amz-Signature');
  expect(body).not.toContain('X-Amz-Credential');
  // The archive itself, and the authenticated route that hands it over — the
  // second is the subtler miss: linking the ROUTE would look safe (it
  // authenticates) while still making the email the delivery mechanism DECISION
  // 2 says it must not be.
  expect(body).not.toContain('.zip');
  expect(body).not.toContain('/api/account/data-export/');
}

beforeEach(async () => {
  blobs.clear();
  emitted.length = 0;
  sendEventImpl.current = async (name, data) => {
    emitted.push({ name, data });
  };
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the export-ready email template', () => {
  it.each(locales)(
    'renders in %s — the pane link, the retention window, no file',
    async (locale) => {
      const rendered = await dataExportReadyEmail({
        recipientName: 'Ada',
        paneUrl: PANE_URL,
        retentionDays: DATA_EXPORT_RETENTION_DAYS,
        locale,
      });

      expect(rendered.subject.length).toBeGreaterThan(0);
      for (const body of [rendered.html, rendered.text]) {
        // The ONE link, in both bodies — the plain-text one unredacted, which is
        // the dev-console provider's contract (CLAUDE.md § email templates).
        expect(body).toContain(PANE_URL);
        // The seven-day promise, interpolated from the constant rather than
        // retyped, so the copy and the sweep cannot drift.
        expect(body).toContain(String(DATA_EXPORT_RETENTION_DAYS));
        assertCarriesNoFileLink(body);
      }
    },
  );

  it('renders DIFFERENT copy per locale — the catalog is really being read', async () => {
    const [en, zh] = await Promise.all(
      (['en', 'zh'] as const).map((locale) =>
        dataExportReadyEmail({
          recipientName: 'Ada',
          paneUrl: PANE_URL,
          retentionDays: DATA_EXPORT_RETENTION_DAYS,
          locale,
        }),
      ),
    );
    // Without this, a missing `zh` namespace would fall back and both cases
    // above would pass on identical English.
    expect(en!.subject).not.toEqual(zh!.subject);
    expect(zh!.text).toContain('Motir');
  });
});

describe('buildDataExport → the export-ready notification', () => {
  async function makeUser() {
    return adminDb.user.create({
      data: {
        email: `exporter-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
        name: 'Exporter',
        emailVerified: true,
      },
    });
  }

  it('enqueues the email AFTER the row is committed ready, and never a link to the file', async () => {
    const user = await makeUser();
    const request = await adminDb.dataExportRequest.create({
      data: { userId: user.id, requestedAt: new Date() },
    });

    const result = await dataExportService.buildDataExport({
      userId: user.id,
      requestId: request.id,
    });
    expect(result.status).toBe('ready');

    const send = emitted.find((e) => e.name === 'email.send');
    expect(send, 'no email.send was enqueued').toBeDefined();
    expect(send!.data).toMatchObject({
      to: user.email,
      template: 'data-export-ready',
      workspaceId: null,
      idempotencyKey: `data-export-ready:${request.id}`,
    });

    // The row it is ABOUT is already `ready` — the send is downstream of the
    // commit, so a reader who ignores the email still finds the archive.
    const persisted = await adminDb.dataExportRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(persisted.status).toBe('ready');
    expect(persisted.blobPathname).toBeTruthy();

    // Render exactly what the job would render, and grep THAT — asserting on
    // the payload alone would let a template that appends a download link pass.
    const data = send!.data.data as {
      recipientName: string;
      paneUrl: string;
      retentionDays: number;
    };
    expect(data.paneUrl.endsWith(DATA_PRIVACY_PANE_PATH)).toBe(true);
    expect(data.retentionDays).toBe(DATA_EXPORT_RETENTION_DAYS);
    const rendered = await dataExportReadyEmail(data);
    assertCarriesNoFileLink(rendered.html);
    assertCarriesNoFileLink(rendered.text);
    expect(rendered.html).toContain(data.paneUrl);
    // And the archive's own key never travels in the payload either.
    expect(JSON.stringify(send!.data)).not.toContain(persisted.blobPathname!);
  });

  it('a send that THROWS leaves the export ready and the build successful', async () => {
    const user = await makeUser();
    const request = await adminDb.dataExportRequest.create({
      data: { userId: user.id, requestedAt: new Date() },
    });
    // The build's own event must still work; only the notification fails —
    // which is the realistic shape (a provider or queue hiccup on one send).
    sendEventImpl.current = async (name, data) => {
      if (name === 'email.send') throw new Error('the mail queue is down');
      emitted.push({ name, data });
    };

    const result = await dataExportService.buildDataExport({
      userId: user.id,
      requestId: request.id,
    });

    // Not `failed`, and not a throw: the archive exists, so the durable state
    // must say so. Coupling the two would route a reader to `privacy@motir.co`
    // over a mail hiccup, on the one surface where a broken promise is also a
    // compliance problem.
    expect(result.status).toBe('ready');
    const persisted = await adminDb.dataExportRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(persisted.status).toBe('ready');
    expect(persisted.failureReason).toBeNull();
    expect(persisted.blobPathname).toBeTruthy();
  });

  it('sends nothing when the account has no address to send to', async () => {
    const user = await makeUser();
    const request = await adminDb.dataExportRequest.create({
      data: { userId: user.id, requestedAt: new Date() },
    });
    await adminDb.user.delete({ where: { id: user.id } });

    // The row cascades with the user, so this is really "the account went away
    // mid-build" — the build must not throw its way into a `failed` write
    // against a row that no longer exists.
    await expect(
      dataExportService.notifyExportReady({ userId: user.id, requestId: request.id }),
    ).resolves.toBeUndefined();
    expect(emitted.find((e) => e.name === 'email.send')).toBeUndefined();
  });
});
