import { afterEach, expect, it, vi } from "vitest";
import { animateMonthlySeries, type ChartHistory } from "./monthlyChartMotion";

function plot() {
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  vi.stubGlobal("CSS", { supports: () => true });
  let path = "M0 8L2 3";
  const animation = { cancel: vi.fn(), playState: "running" };
  const shape = { localName: "path", isConnected: true, getAttribute: () => path, animate: vi.fn(() => animation) };
  const svg = { querySelectorAll: () => [shape] } as unknown as SVGSVGElement;
  const history: ChartHistory = { current: null };
  return {
    change(next: string, domain: string | null = "rub") {
      path = next;
      return animateMonthlySeries(svg, domain, history);
    },
    media, history, shape, animation,
  };
}

afterEach(() => vi.unstubAllGlobals());

it("показывает первый ряд сразу, сравнивает только внутри одной шкалы и забывает кадр при скрытии", () => {
  const { change, shape, history } = plot();
  change("M0 9L2 7");
  change("M0 9L2 7");
  expect(shape.animate).not.toHaveBeenCalled();
  change("M0 8L2 3", "usd");
  expect(shape.animate).not.toHaveBeenCalled();
  change("M0 4L2 1", null);
  expect(history.current).toBeNull();
  change("M0 6L2 1", "usd");
  expect(shape.animate).not.toHaveBeenCalled();
});

it("продолжает быструю смену ряда с видимого кадра и завершает движение по системной настройке", () => {
  const { change, shape, media, animation } = plot();
  change("M0 9L2 7");
  const stop = change("M0 8L2 3");
  expect(shape.animate).toHaveBeenCalledOnce();
  const mid = 'path("M0 8.5L2 5")';
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => mid }));
  stop?.();
  expect(animation.cancel).toHaveBeenCalledOnce();
  change("M0 4L2 1");
  expect(shape.animate).toHaveBeenLastCalledWith([{ d: mid }, { d: 'path("M0 4L2 1")' }], expect.objectContaining({ duration: 200 }));
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  expect(animation.cancel).toHaveBeenCalledTimes(2);
  change("M0 6L2 1");
  expect(shape.animate).toHaveBeenCalledTimes(2);
});
