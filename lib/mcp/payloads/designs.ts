import { z } from 'zod/v4';
import {
  approvedDesignSchema,
  designAssetSchema,
  designVerdictSchema,
} from '@/lib/api/v1/workItems/schema';
import { definePayload } from './define';

// The DESIGN payload shapes (Story MOTIR-5553 · Subtask MOTIR-5561).
//
// Both tools DERIVE from the v1 design components MOTIR-5560 declared, rather
// than restating them — which matters more here than for most resources,
// because the thing being described is a VERDICT: an agent that reads `verdict`
// on one surface and a bare design-or-nothing on the other cannot tell *no
// approved design* from *this blocker is not a design card*, and those two call
// for opposite actions (stop and propose a design card, versus carry on).
//
// ⚠️ THE ASSET-LEVEL PROBE IS SEPARATE, deliberately. `ApprovedDesign` contains
// `DesignAsset`, so probing the design alone would validate the assets only as a
// side effect of the parent schema — and the coverage guard would then report a
// resource as covered that no probe names. The `url` / `expiresAt` pair is
// exactly the part most likely to drift between the two surfaces, so it gets a
// probe of its own that selects the assets wherever they sit.

/** Every asset inside a verdict, flattened — the selector both probes use. */
function assetsOf(verdicts: readonly unknown[]): readonly unknown[] {
  return verdicts.flatMap((verdict) => {
    const design = (verdict as { design?: { assets?: unknown[] } }).design;
    return design?.assets ?? [];
  });
}

/** `get_design` — ONE design card's verdict, with links on available assets. */
export const getDesignPayload = definePayload({
  schema: designVerdictSchema.catchall(z.unknown()) as unknown as z.ZodType<
    Record<string, unknown>
  >,
  probes: [
    { resource: 'DesignVerdict', select: (p) => [p] },
    {
      resource: 'ApprovedDesign',
      select: (p) => (p.design === undefined ? [] : [p.design]),
    },
    { resource: 'DesignAsset', select: (p) => assetsOf([p]) },
  ],
});

/**
 * `list_designs` — EITHER arm.
 *
 * `blockersOf` answers `designs` (verdicts, one per design card the item waits
 * on); the project listing answers `items` + `nextCursor` (approved designs,
 * no links). ONE payload covering both, because they are one tool and a client
 * discriminates on which key is present — declaring two would make the seam
 * describe a shape the tool never returns.
 */
export const listDesignsPayload = definePayload({
  schema: z
    .object({
      designs: z.array(designVerdictSchema).optional(),
      items: z.array(approvedDesignSchema).optional(),
      nextCursor: z.string().nullable().optional(),
    })
    .catchall(z.unknown()) as unknown as z.ZodType<
    {
      designs?: unknown[];
      items?: unknown[];
      nextCursor?: string | null;
    } & Record<string, unknown>
  >,
  probes: [
    { resource: 'DesignVerdict', select: (p) => p.designs ?? [] },
    { resource: 'ApprovedDesign', select: (p) => p.items ?? [] },
    {
      resource: 'DesignAsset',
      select: (p) => [
        ...assetsOf(p.designs ?? []),
        ...(p.items ?? []).flatMap((design) => (design as { assets?: unknown[] }).assets ?? []),
      ],
    },
  ],
});

/** Kept so the asset schema is imported at the type level where it is probed. */
export type McpDesignAsset = z.infer<typeof designAssetSchema>;
