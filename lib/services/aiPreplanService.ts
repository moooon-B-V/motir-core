import { getPreplanState as fetchPreplanState } from '@/lib/ai/motirAiClient';
import type { RawPreplanStateResponse } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';
import type { PreplanStateDTO } from '@/lib/dto/aiPreplan';

// The pre-plan READ-THROUGH service (Subtask 7.3.70): the thin motir-core seam
// the discovery UI (7.3.5) reads its resumable pre-plan state from. This is the
// email.ts-style LEAF-CLIENT pattern — motir-core holds NO pre-plan state; the
// session decisions + revision logs + diffs live in motir-ai and are fetched
// over the 7.1 boundary via the 7.3.25 client primitive (`getPreplanState`,
// which is `server-only`). No pre-plan table is added to motir-core (the
// open-core invariant).
//
// project→AiProject resolution happens on the motir-ai side: the read is keyed by
// the core (workspace, project) ids, and motir-ai resolves its AiProject from
// them READ-ONLY, returning the empty state ({ session: null, docs: [] }) for a
// not-yet-started project (never a 404). So this side just forwards the core ids
// off the already-resolved ProjectContext — the auth/membership + active-project
// gate ran in the route (getSession + getActiveProject, the project analogue of
// getSession — mirrors aiChatService / /api/board). A transport / upstream
// failure throws a typed MotirAiError the route maps to 502.

export const aiPreplanService = {
  // Read the active project's resumable pre-plan state — the session decisions,
  // each artifact's forward revision log, and the per-revision diffs — mapped to
  // the motir-core DTO the browser consumes.
  async getPreplanState(ctx: ProjectContext): Promise<PreplanStateDTO> {
    const raw = await fetchPreplanState({
      coreWorkspaceId: ctx.workspaceId,
      coreProjectId: ctx.projectId,
    });
    return mapPreplanState(raw);
  },
};

// Map the motir-ai wire body to the motir-core DTO: drop the motir-ai-internal
// `aiProjectId` (never leaked to the browser), pass the opaque `conversation` /
// `diff` payloads through verbatim (motir-ai owns their shape; the gate renders
// them), and preserve the forward-only revision ordering motir-ai returns.
function mapPreplanState(raw: RawPreplanStateResponse): PreplanStateDTO {
  return {
    session: raw.session
      ? {
          classification: raw.session.classification,
          platform: raw.session.platform,
          designStarter: raw.session.designStarter,
          validationTiming: raw.session.validationTiming,
          docSkipSet: raw.session.docSkipSet,
          currentGate: raw.session.currentGate,
          status: raw.session.status,
          conversation: raw.session.conversation,
          createdAt: raw.session.createdAt,
          updatedAt: raw.session.updatedAt,
        }
      : null,
    docs: raw.docs.map((doc) => ({
      kind: doc.kind,
      // The latest rendered body the 7.3.5 gate displays (7.3.72/MOTIR-1188),
      // passed through verbatim alongside the forward revision log.
      currentBody: doc.currentBody,
      currentVersion: doc.currentVersion,
      versions: doc.versions.map((v) => ({
        version: v.version,
        changeReason: v.changeReason,
        changeKind: v.changeKind,
        diff: v.diff,
        createdAt: v.createdAt,
      })),
    })),
    // The structured feature catalog (7.3.78), folded into the vision tier by the
    // gate. Mapped onto 834's `FeatureCatalogView` — keeping the per-node ids the
    // list render keys on, dropping the motir-ai-internal catalog id/aiProjectId/
    // timestamps (never leaked to the browser). Null until the vision step drafts it.
    catalog: raw.catalog
      ? {
          categories: raw.catalog.categories.map((cat) => ({
            id: cat.id,
            title: cat.title,
            features: cat.features.map((f) => ({
              id: f.id,
              name: f.name,
              descriptionMd: f.descriptionMd,
              phase: f.phase,
              status: f.status,
            })),
          })),
          glossary: raw.catalog.glossary.map((group) => ({
            id: group.id,
            title: group.title,
            concepts: group.concepts.map((concept) => ({
              id: concept.id,
              term: concept.term,
              aka: concept.aka,
              descriptionMd: concept.descriptionMd,
              example: concept.example,
            })),
          })),
        }
      : null,
  };
}
