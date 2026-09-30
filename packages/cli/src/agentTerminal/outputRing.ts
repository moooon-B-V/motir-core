// A session's replay buffer (MOTIR-6938 · `docs/decisions/agent-terminal.md`
// Q5): the last 256 KiB of the PTY's output, in the server's memory on the
// user's own machine, sent before live output when a session is resumed so the
// screen can be redrawn. It is never written anywhere else.

/** The replay bound per session. */
export const REPLAY_BYTES = 256 * 1024;

export class OutputRing {
  private readonly buffer: Buffer;
  /** Where the next byte is written. */
  private head = 0;
  /** How many bytes are held (≤ capacity). */
  private length = 0;

  constructor(private readonly capacity: number = REPLAY_BYTES) {
    this.buffer = Buffer.alloc(capacity);
  }

  get size(): number {
    return this.length;
  }

  push(chunk: Buffer): void {
    if (chunk.length >= this.capacity) {
      chunk.copy(this.buffer, 0, chunk.length - this.capacity);
      this.head = 0;
      this.length = this.capacity;
      return;
    }
    const first = Math.min(chunk.length, this.capacity - this.head);
    chunk.copy(this.buffer, this.head, 0, first);
    if (first < chunk.length) chunk.copy(this.buffer, 0, first);
    this.head = (this.head + chunk.length) % this.capacity;
    this.length = Math.min(this.capacity, this.length + chunk.length);
  }

  /** The held bytes, oldest first. */
  snapshot(): Buffer {
    if (this.length < this.capacity) {
      return Buffer.from(this.buffer.subarray(this.head - this.length, this.head));
    }
    return Buffer.concat([this.buffer.subarray(this.head), this.buffer.subarray(0, this.head)]);
  }
}
