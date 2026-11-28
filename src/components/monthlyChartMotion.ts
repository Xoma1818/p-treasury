import type { RefObject } from "react";

// Сохраняем только координаты ряда. Подписи, фокус и суммы всегда относятся
// к новому отчёту, в том числе пока загружается ещё не открывавшийся период.
export type ChartFrame = { domain: string; geometry: string[] };
export type ChartHistory = RefObject<ChartFrame | null>;

export function animateMonthlySeries(svg: SVGSVGElement | null, domain: string | null, history: ChartHistory) {
  if (!svg || !domain || !CSS.supports("d", 'path("M0 0L1 1")')) {
    history.current = null;
    return;
  }
  const shapes = [...svg.querySelectorAll<SVGElement>("[data-series]")];
  const property = (shape: SVGElement) => shape.localName === "circle" ? "cy" : "d";
  const geometry = shapes.map(shape => property(shape) === "cy"
    ? shape.getAttribute("cy") + "px"
    : `path("${shape.getAttribute("d")}")`);
  const previous = history.current;
  const frame = { domain, geometry };
  history.current = frame;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  if (!previous || previous.domain !== domain || reduced.matches) return;

  const running: { animation: Animation; index: number }[] = [];
  shapes.forEach((shape, index) => {
    const from = previous.geometry[index];
    const to = geometry[index];
    if (!from || from === to) return;
    const prop = property(shape);
    const animation = shape.animate([{ [prop]: from }, { [prop]: to }],
      { duration: 200, easing: "cubic-bezier(.22,.8,.28,1)" });
    running.push({ animation, index });
  });
  if (!running.length) return;
  const finish = () => running.forEach(({ animation }) => animation.cancel());
  reduced.addEventListener("change", finish);
  return () => {
    reduced.removeEventListener("change", finish);
    // Быстрый повторный выбор продолжает движение из видимого кадра.
    for (const { animation, index } of running) {
      if (animation.playState === "running" && shapes[index].isConnected) {
        geometry[index] = getComputedStyle(shapes[index]).getPropertyValue(property(shapes[index]));
      }
    }
    finish();
  };
}
