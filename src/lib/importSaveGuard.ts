/** Synchronous guard: React state alone cannot reject two events before rerender. */
export class ImportSaveGuard {
  private saving = false;
  get busy() { return this.saving; }
  async run(action: () => Promise<void>): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try { await action(); } finally { this.saving = false; }
  }
}
