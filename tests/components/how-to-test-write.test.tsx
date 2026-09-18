// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { HowToTestBlock, type HowToTestRowRef } from '@/components/howToTest/HowToTestBlock';
import {
  HowToTestWriteProvider,
  type HowToTestSaveResult,
} from '@/components/howToTest/HowToTestWrite';
import type { HowToTestDto } from '@/lib/dto/howToTest';
import type { HowToTestDraftDTO } from '@/lib/dto/testInstructions';
import { CORE_PR, coreRepo, recordDto } from '../helpers/howToTestFixtures';
import messages from '@/messages/en.json';

// THE WRITE DOORS AND THE FORM (Story MOTIR-5450 · Subtask MOTIR-5455), against
// `design/github/design-notes.md` §24 panels 13a · 13b · 13d · 13e · 13f · 13h.
//
// ⚠️ THE ACCESS CASES ARE THE POINT, and they are asserted by MOUNTING NOTHING.
// The block asks for the write context and draws no door without it, so the
// read-only peek and the approval overlay — which render this same block and
// mount no provider — are covered by rendering the block bare. A test that
// passed a `canEdit={false}` flag would be testing a different design.

const t = messages.github.development.howToTest;

const ROW_CORE: HowToTestRowRef = { id: CORE_PR.id, repo: CORE_PR.repo, number: CORE_PR.number };

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy }),
}));

let refreshSpy = vi.fn();
let loadDraft: (
  workItemId: string,
) => Promise<{ ok: true; draft: HowToTestDraftDTO } | { ok: false; error: string }>;
let saveHowToTest: (input: {
  workItemId: string;
  identifier: string;
  bodyMd: string;
  previewPath: string | null;
}) => Promise<HowToTestSaveResult>;
let saved: Array<{ bodyMd: string; previewPath: string | null }>;

const MISSING: HowToTestDto = {
  state: 'record_missing',
  runTarget: null,
  owedBy: { runId: 'run-318', label: 'Parent run #318' },
  record: null,
  repos: [],
  history: [],
};

beforeEach(() => {
  refreshSpy = vi.fn();
  saved = [];
  loadDraft = vi.fn(async () => ({
    ok: true as const,
    draft: { bodyMd: '## Click-path\n\n1. Open it', previewPath: '/items/ACME-12' },
  }));
  saveHowToTest = vi.fn(async (input) => {
    saved.push({ bodyMd: input.bodyMd, previewPath: input.previewPath });
    return { ok: true as const };
  });
});
afterEach(cleanup);

/** The block WITH the doors — the item page's mount, for `work_item:edit`. */
function renderWritable(dto: HowToTestDto, rows: HowToTestRowRef[] = []) {
  return render(
    <HowToTestWriteProvider
      workItemId="wi-1"
      identifier="ACME-12"
      loadDraft={loadDraft}
      saveHowToTest={saveHowToTest}
    >
      <HowToTestBlock howToTest={dto} pullRequestRows={rows} />
    </HowToTestWriteProvider>,
  );
}

/**
 * Open the form and wait on the AUTHORITATIVE signal — the draft's body actually
 * in the editor. The editor builds its view on the client only
 * (`immediatelyRender: false`), so the form element existing is not the same as
 * the draft having landed in it.
 */
async function openForm(name: string, body = 'Click-path') {
  fireEvent.click(screen.getByRole('button', { name }));
  const form = await screen.findByTestId('how-to-test-form');
  await waitFor(() => expect(form.textContent).toContain(body));
  return form;
}

describe('Panel 13a — the doors', () => {
  it('ADD renders under the missing callout, and the callout STAYS', async () => {
    renderWritable(MISSING);
    const part = screen.getByRole('group', { name: t.title });
    // Decision 2: a person writing one by hand does not make the run's omission
    // untrue, and the owed-by line is the only record of which run skipped it.
    expect(part.textContent).toContain(t.missing.title);
    expect(part.textContent).toContain('Parent run #318');
    expect(within(part).getByRole('button', { name: t.add })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.edit })).toBeNull();
  });

  it("EDIT renders in the part head on a record — a person may edit a RUN's record", () => {
    renderWritable(recordDto({ repos: [coreRepo()] }), [ROW_CORE]);
    const part = screen.getByRole('group', { name: t.title });
    // Decision 4: the run's own record, and the door is there anyway — the
    // amendment's reason is that a wrong agent record could otherwise only be
    // fixed by starting another run.
    expect(part.textContent).toContain('Written by Parent run #318');
    expect(within(part).getByRole('button', { name: t.edit })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.add })).toBeNull();
  });
});

describe('Panel 13h — NO door', () => {
  it('a surface with no provider draws neither door, on a record OR on a missing one', () => {
    render(<HowToTestBlock howToTest={recordDto()} pullRequestRows={[ROW_CORE]} />);
    expect(screen.queryByRole('button', { name: t.edit })).toBeNull();
    cleanup();
    render(<HowToTestBlock howToTest={MISSING} pullRequestRows={[]} />);
    expect(screen.queryByRole('button', { name: t.add })).toBeNull();
  });

  it('a CHILD of a container run shows its pointer and no door, even with the provider mounted', () => {
    renderWritable({
      state: 'tested_via_ancestor',
      runTarget: { key: 'ACME-7' },
      owedBy: null,
      record: null,
      repos: [],
      history: [],
    });
    expect(screen.getByRole('link', { name: 'ACME-7' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.add })).toBeNull();
    expect(screen.queryByRole('button', { name: t.edit })).toBeNull();
  });
});

describe('Panel 13b — the form is TWO fields', () => {
  it('opens filled in from the DRAFT READ, not from the rendered record', async () => {
    renderWritable(recordDto({ repos: [coreRepo()] }), [ROW_CORE]);
    await openForm(t.edit);
    expect(loadDraft).toHaveBeenCalledWith('wi-1');
    expect(screen.getByLabelText(/Preview path/)).toHaveProperty('value', '/items/ACME-12');
    expect(screen.getByRole('textbox', { name: t.form.body }).textContent).toContain('Click-path');
  });

  it('has NO control naming a repository or a commit (decision 8b)', async () => {
    renderWritable(recordDto({ repos: [coreRepo()] }), [ROW_CORE]);
    const form = await openForm(t.edit);
    // The whole form, read as text and as controls: the two fields and the two
    // verbs, and nothing that asks for a repository or a commit.
    expect(form.textContent).not.toMatch(/repositor/i);
    expect(form.textContent).not.toMatch(/commit/i);
    expect(within(form).queryByRole('combobox')).toBeNull();
    const labelled = within(form)
      .getAllByRole('textbox')
      .map((el) => el.getAttribute('aria-label') ?? el.id);
    expect(labelled.sort()).toEqual(['Body', 'how-to-test-preview-path']);
  });

  it('the body editor carries the code-block LANGUAGE field (MOTIR-5458)', async () => {
    renderWritable(MISSING);
    await openForm(t.add);
    // The draft body has no fence, so the field is proved by the editor's prop
    // being on: a code block put into the document shows it.
    const form = screen.getByTestId('how-to-test-form');
    fireEvent.click(within(form).getByRole('button', { name: 'Code block' }));
    await waitFor(() => expect(within(form).getByLabelText('Language')).toBeTruthy());
  });

  it('the form REPLACES the record while it is open — the part head stays', async () => {
    renderWritable(recordDto({ repos: [coreRepo()] }), [ROW_CORE]);
    await openForm(t.edit);
    // Scoped by test id, not by role+name: §24's accessibility note labels the
    // FORM *How to test* too, and the part it opens inside already carries that
    // name — so while the form is open there are two groups with one name.
    const part = screen.getByTestId('how-to-test');
    expect(within(part).getByRole('heading', { level: 4, name: t.title })).toBeTruthy();
    expect(part.textContent).not.toContain('Written by Parent run #318');
    expect(screen.queryByText(t.preview.title)).toBeNull();
  });
});

describe('the SAVE', () => {
  it('sends the body and the preview path, closes, and refreshes the server-rendered block', async () => {
    renderWritable(MISSING);
    await openForm(t.add);
    fireEvent.change(screen.getByLabelText(/Preview path/), {
      target: { value: '  /items/ACME-9  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: t.form.save }));
    await waitFor(() => expect(saved).toHaveLength(1));
    // Trimmed, because a stray space is not a different path.
    expect(saved[0]!.previewPath).toBe('/items/ACME-9');
    expect(saved[0]!.bodyMd).toContain('Click-path');
    await waitFor(() => expect(screen.queryByTestId('how-to-test-form')).toBeNull());
    // ⚠️ The block is server-rendered, so the refresh is what redraws the saved
    // record with its author and its history — never an optimistic patch, which
    // would show the new body beside a stale author.
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('an EMPTY preview path is null, not an empty string', async () => {
    loadDraft = vi.fn(async () => ({
      ok: true as const,
      draft: { bodyMd: '## Body', previewPath: null },
    }));
    renderWritable(MISSING);
    await openForm(t.add, 'Body');
    fireEvent.click(screen.getByRole('button', { name: t.form.save }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.previewPath).toBeNull();
  });
});

describe('Panel 13d — the refusals', () => {
  it.each([['bodyMd' as const], ['previewPath' as const]])(
    'a %s refusal renders in the form and KEEPS the draft',
    async (field) => {
      saveHowToTest = vi.fn(async () => ({
        ok: false as const,
        field,
        error: 'the refusal publish returned',
      }));
      renderWritable(MISSING);
      await openForm(t.add);
      fireEvent.change(screen.getByLabelText(/Preview path/), {
        target: { value: 'https://evil.example/' },
      });
      fireEvent.click(screen.getByRole('button', { name: t.form.save }));

      const form = await screen.findByTestId('how-to-test-form');
      await waitFor(() => expect(form.textContent).toContain('the refusal publish returned'));
      // ⚠️ Decision 6: the body is the expensive part of the input, so a refusal
      // about a path must never cost it.
      expect(screen.getByLabelText(/Preview path/)).toHaveProperty(
        'value',
        'https://evil.example/',
      );
      expect(screen.getByRole('textbox', { name: t.form.body }).textContent).toContain(
        'Click-path',
      );
    },
  );

  it('a refusal the form has no field for lands on the FORM rather than being swallowed', async () => {
    saveHowToTest = vi.fn(async () => ({
      ok: false as const,
      field: null,
      error: 'a refusal about something this form does not draw',
    }));
    renderWritable(MISSING);
    await openForm(t.add);
    fireEvent.click(screen.getByRole('button', { name: t.form.save }));
    const form = await screen.findByTestId('how-to-test-form');
    await waitFor(() =>
      expect(form.textContent).toContain('a refusal about something this form does not draw'),
    );
  });
});

describe('CANCEL', () => {
  it('closes the form and writes nothing', async () => {
    renderWritable(recordDto({ repos: [coreRepo()] }), [ROW_CORE]);
    await openForm(t.edit);
    fireEvent.click(screen.getByRole('button', { name: t.form.cancel }));
    await waitFor(() => expect(screen.queryByTestId('how-to-test-form')).toBeNull());
    expect(saved).toHaveLength(0);
    // The record is back, with its author line and its Edit door.
    expect(screen.getByRole('button', { name: t.edit })).toBeTruthy();
  });
});
