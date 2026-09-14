// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { MarkdownView } from '@/components/ui/MarkdownView';

// CLICK-TO-COPY is an OPT-IN on the ONE Markdown pipeline (Story MOTIR-4906 ·
// Subtask MOTIR-5336, design/github §20 · Panel 12d): a How to test body gets a
// bar above every fenced block with the fence's language and a Copy control;
// a description rendered without the option is untouched.

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const TWO_COMMANDS = [
  'Set up:',
  '',
  '```bash',
  "pnpm install --frozen-lockfile && echo 'ok' | tee out.txt",
  '```',
  '',
  'Then run it (`pnpm dev` inline gets no control):',
  '',
  '```nushell',
  'ls | where size > 10mb',
  '  | sort-by modified',
  '```',
].join('\n');

describe('MarkdownView copyableCode (MOTIR-5336)', () => {
  it('renders one copy control per fenced block, and each copies its block exactly', async () => {
    render(<MarkdownView value={TWO_COMMANDS} copyableCode />);
    const controls = screen.getAllByRole('button', { name: 'Copy code' });
    expect(controls).toHaveLength(2);

    await act(async () => {
      fireEvent.click(controls[0]!);
    });
    expect(writeText).toHaveBeenLastCalledWith(
      "pnpm install --frozen-lockfile && echo 'ok' | tee out.txt",
    );

    await act(async () => {
      fireEvent.click(controls[1]!);
    });
    expect(writeText).toHaveBeenLastCalledWith('ls | where size > 10mb\n  | sort-by modified');
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('prints each fence language AS WRITTEN, a known one and an unknown one', () => {
    const { container } = render(<MarkdownView value={TWO_COMMANDS} copyableCode />);
    const langs = [...container.querySelectorAll('.motir-code-block > div > span:first-child')].map(
      (el) => el.textContent,
    );
    expect(langs).toEqual(['bash', 'nushell']);
  });

  it('inline code gets no control', () => {
    render(<MarkdownView value={'Run `pnpm dev` now.'} copyableCode />);
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull();
  });

  it('shows Copied for 2s, announced politely, then returns to rest', async () => {
    vi.useFakeTimers();
    render(<MarkdownView value={'```sh\npnpm dev\n```'} copyableCode />);
    const control = screen.getByRole('button', { name: 'Copy code' });
    expect(control.closest('[aria-live="polite"]')).not.toBeNull();

    await act(async () => {
      fireEvent.click(control);
    });
    expect(control.textContent).toBe('Copied');
    expect(control.getAttribute('data-state')).toBe('copied');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(control.textContent).toBe('Copy');
    expect(control.getAttribute('data-state')).toBe('rest');
  });

  it('says so when the clipboard refuses, and the code stays on screen', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<MarkdownView value={'```sh\npnpm dev\n```'} copyableCode />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(screen.getByText("Couldn't copy — select the text instead")).toBeTruthy();
    expect(screen.getByText('pnpm dev')).toBeTruthy();
  });

  it('with NO clipboard at all (an insecure origin), says so rather than throwing', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<MarkdownView value={'```sh\npnpm dev\n```'} copyableCode />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    });
    expect(screen.getByText("Couldn't copy — select the text instead")).toBeTruthy();
  });

  it('a second copy inside the copied window restarts it, and a bare fence prints no language', async () => {
    vi.useFakeTimers();
    const { container } = render(<MarkdownView value={'```\nmake test\n```'} copyableCode />);
    expect(container.querySelector('.motir-code-block > div > span:first-child')?.textContent).toBe(
      '',
    );
    const control = screen.getByRole('button', { name: 'Copy code' });
    await act(async () => {
      fireEvent.click(control);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await act(async () => {
      fireEvent.click(control);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    // 3s after the first copy, but only 1.5s after the second: still copied.
    expect(control.getAttribute('data-state')).toBe('copied');
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith('make test');
  });

  it('WITHOUT the opt-in, a description renders no copy control at all', () => {
    const { container } = render(<MarkdownView value={TWO_COMMANDS} />);
    expect(screen.queryByRole('button', { name: 'Copy code' })).toBeNull();
    expect(container.querySelector('.motir-code-block')).toBeNull();
    expect(container.querySelectorAll('pre')).toHaveLength(2);
  });
});
