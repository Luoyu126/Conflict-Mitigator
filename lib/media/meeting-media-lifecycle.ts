/** Serializes capture changes and closes captures that finish after teardown. */
export class MeetingMediaLifecycle {
  private active = true;
  private generation = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly stopTracks: () => void;

  constructor(stopTracks: () => void) {
    this.stopTracks = stopTracks;
  }

  activate() {
    this.active = true;
  }

  stop() {
    this.active = false;
    this.generation += 1;
    this.stopTracks();
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const assertActive = () => {
      if (!this.active || generation !== this.generation) {
        throw new Error("Meeting media is no longer active.");
      }
    };
    const result = this.pending.then(async () => {
      assertActive();
      try {
        const value = await operation();
        assertActive();
        return value;
      } finally {
        // A device permission dialog may resolve after the provider unmounts.
        if (!this.active || generation !== this.generation) this.stopTracks();
      }
    });
    this.pending = result.catch(() => undefined);
    return result;
  }
}
