import type { DesignAutoRerun } from '@/generated/prisma/client';
import { DESIGN_AUTO_RERUN_CAP } from '@/lib/approvalGates/designAutoRerunCap';
import type { DesignAutoRerunDTO } from '@/lib/dto/approvalGate';

/** A `design_auto_rerun` row as the design gate's record band reads it (MOTIR-702). */
export function toDesignAutoRerunDto(row: DesignAutoRerun): DesignAutoRerunDTO {
  return {
    outcome: row.outcome,
    skipReason: row.skipReason,
    dispatchRunId: row.dispatchRunId,
    ordinal: row.ordinal,
    cap: DESIGN_AUTO_RERUN_CAP,
    detail: row.detail,
  };
}
