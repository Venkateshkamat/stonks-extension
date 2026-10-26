export interface Disposable {
  dispose(): void;
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

/** Minimal event emitter, API-compatible with vscode.Event for subscribers. */
export class Emitter<T> {
  private listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error('[stonks] listener error', err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
