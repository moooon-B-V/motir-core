import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE ORGANISATION'S CONTENT LANGUAGE IN THE DISPATCH PROMPT, OVER REAL STATE
// (Story MOTIR-7734 · Subtask MOTIR-8745). Real Postgres through
// `dispatchPromptService.getDispatchPrompt`: the prompt names the organisation's
// stored language, falls back to the default for a null or unknown value, and is
// still produced — in the default language — when the read itself fails.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function setLanguage(language: string) {
  await adminDb.organization.update({
    where: { id: fx.workspace.organizationId },
    data: { contentLanguage: language },
  });
}

async function promptFor() {
  const item = await createTestWorkItem(fx, { kind: 'task', type: 'code', title: 'Build it' });
  return (await dispatchPromptService.getDispatchPrompt(fx.projectId, item.identifier, fx.ctx))
    .prompt;
}

describe('dispatchPromptService — the content language (MOTIR-8745)', () => {
  it("names the organisation's language", async () => {
    await setLanguage('ja');
    expect(await promptFor()).toContain(
      'This organisation writes its work content in Japanese (`ja`).',
    );
  });

  // The column is NOT NULL and the app writes only the eleven codes, so a null or
  // unknown value is what the read ANSWERS, not something a fixture can store.
  it.each([[null], ['xx']])('a read answering %s falls back to the default', async (stored) => {
    await setLanguage('ja');
    vi.spyOn(organizationRepository, 'findContentLanguageByWorkspaceId').mockResolvedValue(stored);
    expect(await promptFor()).toContain(
      'This organisation writes its work content in English (`en`).',
    );
  });

  it('a read that rejects still produces the prompt, in the default language', async () => {
    await setLanguage('ja');
    vi.spyOn(organizationRepository, 'findContentLanguageByWorkspaceId').mockRejectedValue(
      new Error('boom'),
    );
    expect(await promptFor()).toContain(
      'This organisation writes its work content in English (`en`).',
    );
  });
});
