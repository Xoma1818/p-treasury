import { describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { ADD_KEY, DEFAULT_NAV, isDefaultNav, NAV_KEY, navSections, parseAddMain, parseNav, resetNavPrefs, saveAddMain, savedAddMain, savedNav } from "./navLayout";
import { afterUiPrefsSaved, loadPrefs, prefsToApply, uiPrefsReadRevision } from "./uiPrefs";

const all = () => true;

describe("Г4: своё меню", () => {
  it("пустое или испорченное значение — меню как было", () => {
    expect(parseNav(null)).toEqual(DEFAULT_NAV);
    expect(parseNav("{не json")).toEqual(DEFAULT_NAV);
    expect(isDefaultNav(parseNav(""))).toBe(true);
  });

  it("неизвестные разделы отбрасываются, новые встают в конец, Главную и Настройки не скрыть", () => {
    const l = parseNav(JSON.stringify({ order: ["budget", "budget", "nope", "home"], hidden: ["home", "settings", "notes", "x"] }));
    expect(l.order.slice(0, 2)).toEqual(["budget", "home"]);
    expect(l.order).toHaveLength(DEFAULT_NAV.order.length);
    expect(l.order).not.toContain("settings");
    expect(l.hidden).toEqual(["notes"]);
    expect(isDefaultNav(l)).toBe(false);
  });

  it("меню: свой порядок, без скрытых и выключенных модулей, Настройки последними", () => {
    const l = parseNav(JSON.stringify({ order: ["accounts", "home"], hidden: ["calendar"] }));
    const ids = navSections(l, (id) => id !== "notes").map((s) => s.id);
    expect(ids.slice(0, 2)).toEqual(["accounts", "home"]);
    expect(ids).not.toContain("calendar");
    expect(ids).not.toContain("notes");
    expect(ids.at(-1)).toBe("settings");
    expect(navSections(DEFAULT_NAV, all).map((s) => s.id)[0]).toBe("home");
  });

  it("Г6: главная кнопка — расход, если не выбрано иное", () => {
    expect(parseAddMain(null)).toBe("expense");
    expect(parseAddMain("income")).toBe("income");
    expect(parseAddMain("bad")).toBe("expense");
  });

  it("сбрасывает меню и кнопку одним снимком после предыдущего сохранения", async () => {
    const compact = JSON.stringify({ ...DEFAULT_NAV, hidden: ["calendar"] });
    const mem = new Map([[NAV_KEY, compact], [ADD_KEY, "expense"]]);
    const storage = { getItem: (key: string) => mem.get(key) ?? null, setItem: (key: string, value: string) => void mem.set(key, value) };
    const dispatchEvent = vi.fn(() => ({ nav: savedNav(), add: savedAddMain() }));
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { dispatchEvent });
    let finishPrevious: () => void = () => {};
    const previous = new Promise<void>((resolve) => { finishPrevious = resolve; });
    const persist = vi.spyOn(api, "setSetting").mockImplementationOnce(() => previous).mockResolvedValue(undefined);
    try {
      loadPrefs(JSON.stringify(Object.fromEntries(mem)), storage);
      const earlierRead = uiPrefsReadRevision();
      saveAddMain("transfer");
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      dispatchEvent.mockClear();
      resetNavPrefs();
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      expect(dispatchEvent.mock.results[0].value).toEqual({ nav: DEFAULT_NAV, add: "expense" });
      const old = JSON.stringify({ [NAV_KEY]: compact, [ADD_KEY]: "transfer" });
      const restore = vi.fn(async () => {
        expect(persist).toHaveBeenCalledTimes(2);
        expect(uiPrefsReadRevision()).toBeNull();
      });
      const replacement = afterUiPrefsSaved(restore);
      await Promise.resolve();
      expect(restore).not.toHaveBeenCalled();
      expect(persist).toHaveBeenCalledExactlyOnceWith("ui_prefs", old);
      expect(prefsToApply(old)).toBe(false);
      finishPrevious();
      await replacement;
      expect(restore).toHaveBeenCalledOnce();
      expect(uiPrefsReadRevision()).not.toEqual(earlierRead);
      expect(persist).toHaveBeenCalledTimes(2);
      expect(JSON.parse(persist.mock.calls[1][1])).toEqual({ [NAV_KEY]: JSON.stringify(DEFAULT_NAV), [ADD_KEY]: "expense" });
    } finally {
      finishPrevious();
      persist.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
