import { describe, expect, it, vi } from "vitest";
import { ImportSaveGuard } from "./importSaveGuard";

describe("import save coordination", () => {
  it("sends only one save while the first request is unresolved", async () => {
    const guard = new ImportSaveGuard();
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = guard.run(save);
    await guard.run(save);
    expect(save).toHaveBeenCalledTimes(1);
    expect(guard.busy).toBe(true);
    finish(); await first;
    expect(guard.busy).toBe(false);
  });
  it("allows retry after a rejected save", async () => {
    const guard = new ImportSaveGuard();
    await expect(guard.run(async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(guard.busy).toBe(false);
    const retry = vi.fn(async () => {});
    await guard.run(retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
