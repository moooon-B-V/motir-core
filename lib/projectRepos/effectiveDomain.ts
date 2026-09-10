import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import type { ConnectedRepoName } from '@/lib/workItems/targetRepo';
import type { ProjectRepoName } from './names';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// THE PROJECT LINK IS THE REPOSITORY ISOLATION BOUNDARY (MOTIR-4955).
// A GithubRepo says an organisation connected a repository. A ProjectRepo says
// one project may use it. An empty set therefore reaches nothing; it never
// inherits the workspace's connected repositories.
export interface EffectiveRepoDomain {
  scope: 'project';
  hasSet: boolean;
  /** Retained during the room DTO migration; the workspace rung is retired. */
  layersConnected: false;
  /** Organisation connections are candidates, not project membership. */
  connected: ConnectedRepoName[];
  dispatchable: ConnectedRepoName[];
  pinnable: ConnectedRepoName[];
  projectRows: ProjectRepoName[];
}

export async function resolveEffectiveRepoDomain(
  projectId: string,
  ctx: ServiceContext,
): Promise<EffectiveRepoDomain> {
  const domains = await projectRepoSetService.getRepoNameDomains(projectId, ctx);
  return {
    scope: 'project',
    hasSet: domains.hasSet,
    layersConnected: false,
    connected: [],
    dispatchable: domains.dispatchable,
    pinnable: domains.pinnable,
    projectRows: domains.pinnable,
  };
}
