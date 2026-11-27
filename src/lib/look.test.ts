import { describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { ACCENTS, applyLook, DEFAULT_LOOK, LOOK_KEY, PALETTES, parseLook, savedLook, showLook, useLook } from "./look";
import { afterUiPrefsSaved, loadPrefs } from "./uiPrefs";

describe("палитра, плотность и акцент", () => {
  it("новое окно получает петроль, акцент палитры и обычную плотность", () => {
    expect(DEFAULT_LOOK).toEqual({ palette: "petrol", density: "normal", accent: "palette" });
    expect(parseLook(null)).toEqual(DEFAULT_LOOK);
    expect(parseLook("{")).toEqual(DEFAULT_LOOK);
  });
  it.each(ACCENTS)("при обновлении сохраняет старый явный акцент $value и плотность", ({value: accent}) => {
    expect(parseLook(JSON.stringify({ accent, density: "roomy" }))).toEqual({ palette: "petrol", accent, density: "roomy" });
  });
  it.each(PALETTES)("сохраняет $label с личным акцентом и цветом палитры", ({value: palette}) => {
    for (const accent of ["mint", "palette"]) {
      const look = { palette, accent, density: "compact" };
      expect(parseLook(JSON.stringify(look))).toEqual(look);
    }
  });
  it("неизвестное значение заменяет только в соответствующем поле", () => {
    expect(parseLook('{"palette":"new","density":"compact","accent":"blue"}')).toEqual({ palette: "petrol", density: "compact", accent: "blue" });
    expect(parseLook('{"palette":"plum","accent":"new"}')).toEqual({ palette: "plum", density: "normal", accent: "palette" });
    expect(parseLook(JSON.stringify({ density: "huge", accent: "red" }))).toEqual(DEFAULT_LOOK);
  });
  it("сохраняет выбор в копии бюджета, меняет оформление открытого окна при восстановлении", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const dataset: Record<string, string> = { theme: "light" };
    const persist = vi.spyOn(api, "setSetting").mockResolvedValue(undefined);
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("document", { documentElement: { dataset } });
    try {
      loadPrefs("{}", storage);
      const look = { ...DEFAULT_LOOK, palette: "plum", density: "compact" } as const;
      applyLook(look);
      await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
      expect(persist).toHaveBeenCalledWith("ui_prefs", JSON.stringify({ [LOOK_KEY]: JSON.stringify(look) }));
      expect(savedLook()).toEqual(look);
      expect(dataset).toEqual({ ...look, theme: "light" });

      const oldBackup = JSON.stringify({ [LOOK_KEY]: '{"density":"normal","accent":"mint"}' });
      await afterUiPrefsSaved(async () => undefined);
      expect(loadPrefs(oldBackup, storage, { restore: true })).toEqual([LOOK_KEY]);
      showLook(savedLook());
      expect(dataset).toEqual({ palette: "petrol", accent: "mint", theme: "light" });
      expect(useLook.getState()).toEqual({ ...DEFAULT_LOOK, accent: "mint" });
      expect(values.get(LOOK_KEY)).toBe('{"density":"normal","accent":"mint"}');
    } finally {
      useLook.setState(DEFAULT_LOOK, true);
      persist.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
