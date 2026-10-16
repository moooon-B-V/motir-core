// The committed import-sample fixture obeys its own rules (MOTIR-8756).
//
// Runs the pure validator over the files as committed. A failure prints every
// violation as `[rule] <id>: <message>`, so the CI log names the record to fix.
// The mutation suite beside this file proves each rule actually fires.

import { describe, expect, it } from 'vitest';

import { loadExpected, loadProject, loadTranslation } from '../fixtures/importSample';
import { formatViolations, validateFixture } from '../fixtures/importSample/validate';

describe('import-sample fixture validity', () => {
  it('the committed project, translation table and expected results have no violations', () => {
    const violations = validateFixture({
      project: loadProject(),
      translation: loadTranslation(),
      expected: {
        jira: loadExpected('jira'),
        linear: loadExpected('linear'),
        plane: loadExpected('plane'),
      },
    });

    expect(violations, `fixture violations:\n${formatViolations(violations)}`).toEqual([]);
  });
});
