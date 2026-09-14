// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlacementLine, PlacementSide } from '@/components/planning/FolderPlacement';

// The edges of the folder-placement primitives (Story MOTIR-5310 · MOTIR-5420's
// coverage floor over MOTIR-5418): the arms the panel tests never reach because
// a well-formed review model never sends them — a filed card whose path is
// empty, and a folder side whose path is absent without being marked missing.

afterEach(() => {
  cleanup();
});

describe('PlacementLine', () => {
  it('draws nothing for an unfiled card or an empty path', () => {
    const { container, rerender } = renderWithIntl(
      <PlacementLine folderPath={null} folderMissing={false} />,
    );
    expect(container.innerHTML).toBe('');
    rerender(<PlacementLine folderPath={[]} folderMissing={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('reads the full path for assistive tech on a filed card', () => {
    renderWithIntl(<PlacementLine folderPath={['Parked', '2025']} folderMissing={false} />);
    expect(screen.getByTestId('placement-line').textContent).toContain('Filed in Parked ▸ 2025');
  });
});

describe('PlacementSide', () => {
  it('reads Folder deleted for a missing folder, and for a folder side with no path', () => {
    const { rerender } = renderWithIntl(
      <PlacementSide
        side={{ kind: 'folder', folderId: 'f1', folderPath: ['Parked'], folderMissing: true }}
        fallback={null}
        max={3}
        className=""
      />,
    );
    expect(screen.getByText('Folder deleted')).toBeTruthy();
    rerender(
      <PlacementSide
        side={{ kind: 'folder', folderId: 'f1', folderPath: null, folderMissing: false }}
        fallback={null}
        max={3}
        className=""
      />,
    );
    expect(screen.getByText('Folder deleted')).toBeTruthy();
  });

  it('reads Project root for the root side, and the fallback for a work item with no identifier', () => {
    const { rerender } = renderWithIntl(
      <PlacementSide side={{ kind: 'root' }} fallback={null} max={3} className="" />,
    );
    expect(screen.getByText('Project root')).toBeTruthy();
    rerender(
      <PlacementSide
        side={{ kind: 'workItem', id: 'w1', identifier: null as unknown as string }}
        fallback="PROD-7"
        max={3}
        className=""
      />,
    );
    expect(screen.getByText('PROD-7')).toBeTruthy();
    rerender(
      <PlacementSide
        side={{ kind: 'workItem', id: 'w1', identifier: null as unknown as string }}
        fallback={null}
        max={3}
        className=""
      />,
    );
    expect(screen.getByText('—')).toBeTruthy();
  });
});
