import { expect, it, vi } from "vitest";
import { api } from "./api";
import { afterUiPrefsSaved, currentBudgetGeneration, withBudgetWrite } from "./uiPrefs";

it("дожидается записи раскладки перед сменой бюджета и отсекает прежний черновик", async () => {
  const generation = currentBudgetGeneration()!;
  let finish!: () => void;
  const persist = vi.spyOn(api, "setSetting").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const open = vi.fn(async () => {});
  try {
    const first = withBudgetWrite(generation, () => api.setSetting("home_layout", "first"));
    const switchFile = afterUiPrefsSaved(open);
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(open).not.toHaveBeenCalled();
    await expect(withBudgetWrite(generation, () => api.setSetting("home_layout", "late"))).rejects.toThrow();
    finish();
    await Promise.all([first, switchFile]);
    await expect(withBudgetWrite(generation, () => api.setSetting("home_layout", "stale"))).rejects.toThrow();
    expect(persist).toHaveBeenCalledExactlyOnceWith("home_layout", "first");
  } finally {
    finish?.();
    persist.mockRestore();
  }
});

it("возвращает ошибку записи и позволяет повторить сохранение", async () => {
  const persist = vi.spyOn(api, "setSetting").mockRejectedValueOnce(new Error("Диск заполнен")).mockResolvedValueOnce(undefined);
  try {
    const generation = currentBudgetGeneration()!;
    await expect(withBudgetWrite(generation, () => api.setSetting("home_layout", "draft"))).rejects.toThrow("Диск заполнен");
    await withBudgetWrite(generation, () => api.setSetting("home_layout", "draft"));
    expect(persist).toHaveBeenCalledTimes(2);
  } finally {
    persist.mockRestore();
  }
});
