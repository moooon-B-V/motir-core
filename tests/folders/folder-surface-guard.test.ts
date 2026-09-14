import { describe, expect, it } from 'vitest';
import {
  domainErrorStatusCodes,
  exportedErrorClasses,
  FOLDER_ERRORS_FILE,
  interfaceMembers,
  readRepoFile,
  schemaOwnKeys,
  TOOL_RESULT_FILE,
  toToolErrorInstanceofClasses,
  V1_ERRORS_FILE,
  V1_WORK_ITEM_SCHEMA_FILE,
  WORK_ITEM_DTO_FILE,
} from './folderSurfaceScan';

// THE FOLDER SURFACE GUARDS (Story MOTIR-5310 · MOTIR-5420), in the structural
// lane: `pnpm test:guards`.
//
// 1  EVERY FOLDER ERROR IS MAPPED ON BOTH AGENT-FACING DOORS. The population is
//    the classes `lib/folders/errors.ts` EXPORTS, read from the file — not a list
//    typed here — so a folder error added later without a `DOMAIN_ERROR_STATUS`
//    row (it would reach an integration as a bare 500) or without a
//    `toToolError` case (an untyped tool error) fails this by name.
// 2  PLACEMENT LIVES ON THE DETAIL READS ONLY. `WorkItemDto` and the `/api/v1`
//    work-item LIST row carry no folder field; the story decided an agent reads
//    an item's own placement where it reads one item.

const folderErrors = exportedErrorClasses(readRepoFile(FOLDER_ERRORS_FILE));

/** The guard itself, over arbitrary texts — what the control drives. */
function unmappedFolderErrors(errorsText: string, v1Text: string, toolText: string): string[] {
  const statuses = new Set(domainErrorStatusCodes(v1Text));
  const toolCases = new Set(toToolErrorInstanceofClasses(toolText));
  return exportedErrorClasses(errorsText).flatMap(({ name, code }) => {
    const missing: string[] = [];
    if (code === '') missing.push(`${name}: no string-literal \`code\``);
    else if (!statuses.has(code)) missing.push(`${name} (${code}): no DOMAIN_ERROR_STATUS row`);
    if (!toolCases.has(name)) missing.push(`${name}: no toToolError case`);
    return missing;
  });
}

describe('every folder error is mapped on /api/v1 and on the MCP', () => {
  it('reads a real population — the scan is not vacuous', () => {
    // A parser that stopped matching would report zero classes and read exactly
    // like a module with nothing to map. The placement conflict is the one class
    // this story added, so its presence proves the scan ran over today's file.
    expect(folderErrors.map((c) => c.name)).toContain('PlacementConflictError');
    expect(folderErrors.length).toBeGreaterThanOrEqual(7);
    expect(domainErrorStatusCodes(readRepoFile(V1_ERRORS_FILE))).toContain('NOT_A_MEMBER');
    expect(toToolErrorInstanceofClasses(readRepoFile(TOOL_RESULT_FILE))).toContain(
      'NotAMemberError',
    );
  });

  it('each exported folder error has a DOMAIN_ERROR_STATUS row AND a toToolError case', () => {
    expect(
      unmappedFolderErrors(
        readRepoFile(FOLDER_ERRORS_FILE),
        readRepoFile(V1_ERRORS_FILE),
        readRepoFile(TOOL_RESULT_FILE),
      ),
      'Map the error in lib/api/v1/errors.ts DOMAIN_ERROR_STATUS and in lib/mcp/toolResult.ts toToolError.',
    ).toEqual([]);
  });

  it('CONTROL — a throwaway exported folder error with no mapping fails the guard by name', () => {
    const withThrowaway = `${readRepoFile(FOLDER_ERRORS_FILE)}
export class FolderThrowawayError extends Error {
  readonly code = 'FOLDER_THROWAWAY' as const;
}
`;
    expect(
      unmappedFolderErrors(
        withThrowaway,
        readRepoFile(V1_ERRORS_FILE),
        readRepoFile(TOOL_RESULT_FILE),
      ),
    ).toEqual([
      'FolderThrowawayError (FOLDER_THROWAWAY): no DOMAIN_ERROR_STATUS row',
      'FolderThrowawayError: no toToolError case',
    ]);
  });
});

describe('placement lives on the detail reads, never on a list row', () => {
  const dtoText = readRepoFile(WORK_ITEM_DTO_FILE);
  const schemaText = readRepoFile(V1_WORK_ITEM_SCHEMA_FILE);
  const folderish = (keys: string[]) => keys.filter((k) => /folder/i.test(k));

  it('reads real shapes — the detail schema does carry the two placement fields', () => {
    expect(schemaOwnKeys(schemaText, 'workItemDetailSchema')).toEqual(
      expect.arrayContaining(['folderId', 'folderPath']),
    );
    expect(interfaceMembers(dtoText, 'WorkItemDto')).toContain('identifier');
    expect(schemaOwnKeys(schemaText, 'workItemFieldsSchema')).toContain('title');
  });

  it('WorkItemDto carries no folder field', () => {
    expect(folderish(interfaceMembers(dtoText, 'WorkItemDto'))).toEqual([]);
  });

  it('the /api/v1 list row (workItemSummarySchema over workItemFieldsSchema) carries no folder field', () => {
    expect(folderish(schemaOwnKeys(schemaText, 'workItemFieldsSchema'))).toEqual([]);
    expect(folderish(schemaOwnKeys(schemaText, 'workItemSummarySchema'))).toEqual([]);
  });
});
