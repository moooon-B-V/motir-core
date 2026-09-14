import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { githubAppRoleForRepo } from '@/lib/github/appRoleForRepo';

// THE APP CHOSEN BY PROVENANCE (MOTIR-5511; `approval-gates.md` §4, second amendment
// decision 7). Pure — no database, no environment. The resolver TAKES the host owner,
// so every arm is driven by an argument rather than a stubbed env var.

/** The provisioning organisation, as an operator typed it into the env. */
const HOST_OWNER = 'motir-projects';

describe('githubAppRoleForRepo', () => {
  it('drives one HOSTED and one IMPORTED repository and resolves each to its own App', () => {
    const hosted = { owner: 'motir-projects' };
    const imported = { owner: 'acme-inc' };

    const roles = {
      hosted: githubAppRoleForRepo(hosted, HOST_OWNER),
      imported: githubAppRoleForRepo(imported, HOST_OWNER),
    };

    expect(roles).toEqual({ hosted: 'provisioning', imported: 'user-facing' });
  });

  it('compares the owner case-insensitively — a webhook echoes the stored casing, the env is whatever was typed', () => {
    expect(githubAppRoleForRepo({ owner: 'Motir-Projects' }, 'motir-projects')).toBe(
      'provisioning',
    );
    expect(githubAppRoleForRepo({ owner: 'motir-projects' }, 'MOTIR-PROJECTS')).toBe(
      'provisioning',
    );
  });

  it('resolves every other owner to the user-facing App', () => {
    for (const owner of ['acme-inc', 'motir-projects-fork', 'projects', '']) {
      expect(githubAppRoleForRepo({ owner }, HOST_OWNER)).toBe('user-facing');
    }
  });

  it('resolves user-facing when hostOwner is null — a deployment that cannot provision hosts nothing', () => {
    expect(githubAppRoleForRepo({ owner: 'motir-projects' }, null)).toBe('user-facing');
    expect(githubAppRoleForRepo({ owner: 'acme-inc' }, null)).toBe('user-facing');
  });

  // ⚠️ BUG MOTIR-4892's SHAPE, GUARDED AT THE SOURCE. The hosted-owner comparison was
  // spelled three times and disagreed about one row; this module must COMPOSE the one
  // spelling in `lib/git/hostOwnership.ts`, not add a fourth.
  it('composes isMotirHostedOwner and carries no owner comparison of its own', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib/github/appRoleForRepo.ts'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n');

    expect(code).toMatch(/import \{ isMotirHostedOwner \} from '@\/lib\/git\/hostOwnership'/);
    expect(code).toMatch(/isMotirHostedOwner\(repo\.owner, hostOwner\)/);
    expect(code).not.toMatch(/toLowerCase|toUpperCase|localeCompare/);
    expect(code).not.toMatch(/===|!==/);
    expect(code).not.toMatch(/process\.env|provisioningOrgLogin/);
  });
});
