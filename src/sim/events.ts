/**
 * Simulation events, drained by the HUD and audio.
 *
 * The sim never calls out to a renderer or an audio context -- it appends to a ring
 * buffer and presentation reads it. That is what keeps the sim pure enough to run
 * headless, and it also means a 30 fps display cannot miss an event that happened
 * on an intermediate substep.
 */
export const enum SimEventKind {
  Pop = 0,
  TrickStart = 1,
  TrickBreak = 2,
  Land = 3,
  Crash = 4,
  Checkpoint = 5,
  Finish = 6,
  OutOfBounds = 7,
  BackInBounds = 8,
  PumpBoost = 9,
  SurfaceChange = 10,
}

/**
 * A flat, reusable event record.
 *
 * Deliberately one shape with generic numeric slots rather than a discriminated
 * union of object literals: events are emitted from the hot loop, and a union would
 * mean allocating a fresh object per event and handing the GC work during a carve.
 */
export interface SimEvent {
  kind: SimEventKind;
  tick: number;
  a: number;
  b: number;
  c: number;
}

export class EventBuffer {
  private readonly events: SimEvent[] = [];
  private count = 0;

  constructor(private readonly capacity = 64) {
    for (let i = 0; i < capacity; i++) {
      this.events.push({ kind: SimEventKind.Pop, tick: 0, a: 0, b: 0, c: 0 });
    }
  }

  push(kind: SimEventKind, tick: number, a = 0, b = 0, c = 0): void {
    // Drop on overflow rather than growing. Overflowing means presentation stopped
    // draining, and in that situation the newest events are the useful ones -- but
    // dropping the oldest would reorder, so we drop the newest and keep it simple.
    if (this.count >= this.capacity) return;
    const e = this.events[this.count++];
    e.kind = kind;
    e.tick = tick;
    e.a = a;
    e.b = b;
    e.c = c;
  }

  /** Read events recorded since the last drain. Valid until `clear()`. */
  get pending(): readonly SimEvent[] {
    return this.events.slice(0, this.count);
  }

  /** Iterate without allocating. Prefer this in the render path. */
  forEach(fn: (e: SimEvent) => void): void {
    for (let i = 0; i < this.count; i++) fn(this.events[i]);
  }

  get length(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
  }
}
