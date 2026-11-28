import { afterEach, expect, it, vi } from "vitest";
import { api, type Figure } from "../lib/api";
import { DEFAULT_LAYOUT, moveBlock, parseLayout, toggleBlock, toSetting } from "../lib/homeLayout";
import { afterUiPrefsSaved, currentBudgetGeneration } from "../lib/uiPrefs";
import { parseFigures, writeHomeFigures } from "./Figures";

afterEach(() => vi.restoreAllMocks());

const figure: Figure = { id: "food", title: "Расходы за месяц", measure: "expense", period: "month" };

it("повторяет раскрытие карточки после ошибки и сохраняет порядок, ширины и чужой показатель", async () => {
  const layout = moveBlock(DEFAULT_LAYOUT, "recent", -1);
  const settings = { home_figures: "[]", home_layout: toSetting(layout) };
  vi.spyOn(api, "getSettings").mockImplementation(async () => ({ ...settings }));
  vi.spyOn(api, "saveFigures").mockImplementation(async next => { settings.home_figures = JSON.stringify(next); });
  vi.spyOn(api, "setSetting").mockRejectedValueOnce(new Error("Диск заполнен")).mockImplementation(async (_, value) => { settings.home_layout = value; });
  const generation = currentBudgetGeneration();
  const upsert = (list: Figure[]) => [...list.filter(item => item.id !== figure.id), figure];
  await expect(writeHomeFigures(generation, upsert, true)).rejects.toThrow("Диск заполнен");
  expect(parseFigures(settings.home_figures)).toEqual([figure]);
  const other = { ...figure, id: "other" };
  settings.home_figures = JSON.stringify([other, figure]);
  await writeHomeFigures(generation, upsert, true);
  expect(parseFigures(settings.home_figures)).toEqual([other, figure]);
  expect(parseLayout(settings.home_layout)).toEqual(toggleBlock(layout, "figures"));
  await writeHomeFigures(generation, list => list.filter(item => item.id !== figure.id), false);
  expect(parseFigures(settings.home_figures)).toEqual([other]);
  expect(api.setSetting).toHaveBeenCalledTimes(2);
});

it("смена бюджета ждёт и сохранения показателя, и раскрытия карточки", async () => {
  let finish!: () => void;
  vi.spyOn(api, "getSettings").mockResolvedValue({ home_figures: "[]", home_layout: toSetting(DEFAULT_LAYOUT) });
  vi.spyOn(api, "saveFigures").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const show = vi.spyOn(api, "setSetting").mockResolvedValue(undefined);
  const write = writeHomeFigures(currentBudgetGeneration(), () => [figure], true);
  const switchFile = vi.fn(async () => expect(show).toHaveBeenCalledOnce());
  const replacement = afterUiPrefsSaved(switchFile);
  await vi.waitFor(() => expect(api.saveFigures).toHaveBeenCalledOnce());
  expect(switchFile).not.toHaveBeenCalled();
  finish();
  await Promise.all([write, replacement]);
  expect(switchFile).toHaveBeenCalledOnce();
});
