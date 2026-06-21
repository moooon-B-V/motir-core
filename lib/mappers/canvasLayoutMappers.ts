import type { CanvasNodePosition } from '@prisma/client';
import type { CanvasLayoutDTO, CanvasNodePositionDTO } from '@/lib/dto/canvasLayout';

// Prisma row → DTO (CLAUDE.md: services map via lib/mappers before returning).
// Drops the internal ids/timestamps; the browser only needs nodeKey + x/y.

export function toCanvasNodePositionDTO(row: CanvasNodePosition): CanvasNodePositionDTO {
  return { nodeKey: row.nodeKey, x: row.x, y: row.y };
}

export function toCanvasLayoutDTO(rows: CanvasNodePosition[]): CanvasLayoutDTO {
  return { positions: rows.map(toCanvasNodePositionDTO) };
}
