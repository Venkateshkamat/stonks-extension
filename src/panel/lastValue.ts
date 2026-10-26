/** Remembers the last value passed through it (as JSON) so unchanged values can be skipped. */
export class LastValue {
  private last?: string;

  /** True when `value` differs from the previous one (and remembers it). */
  changed(value: unknown): boolean {
    const json = JSON.stringify(value);
    if (json === this.last) return false;
    this.last = json;
    return true;
  }

  reset(): void {
    this.last = undefined;
  }
}
