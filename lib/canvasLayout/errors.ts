// Typed errors for the canvas-layout domain (CLAUDE.md: services throw typed
// errors the route maps to HTTP status codes).

export class InvalidCanvasPositionError extends Error {
  readonly code = 'INVALID_CANVAS_POSITION';
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidCanvasPositionError';
  }
}
