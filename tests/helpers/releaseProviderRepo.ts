import { adminDb } from './adminDb';

/**
 * The organisation that connected a provider repository DISCONNECTS it, so the
 * next tenant connecting the same installation can claim it (MOTIR-8218).
 *
 * A repository belongs to ONE organisation (`trg_github_repo_one_organization`),
 * and `persistInstallation` no longer re-stamps a repository another organisation
 * holds. Scenario builders that seed several tenants on ONE installation and ONE
 * repository used to lean on "the last connect wins"; they now say the step that
 * makes that true. Deleting the rows cascades the earlier tenant's pull requests
 * and deliveries, which is what a disconnect does.
 */
export async function releaseProviderRepo(repoId: string, provider = 'github'): Promise<void> {
  await adminDb.githubRepo.deleteMany({ where: { provider, repoId } });
}
