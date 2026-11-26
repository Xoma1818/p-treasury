import { useUi } from "./store";

// Вводный эффект карточек и календаря включён только при первом открытии раздела.
// При повторном посещении CSS видит data-seen и сразу показывает элементы.
export function installSeenSections() {
  const seen = new Set([useUi.getState().section]);
  const root = document.documentElement;
  useUi.subscribe((s, prev) => {
    if (s.section === prev.section && s.visit === prev.visit) return;
    root.toggleAttribute("data-seen", seen.has(s.section));
    root.toggleAttribute("data-route-change", s.section !== prev.section);
    seen.add(s.section);
  });
}

/** Only the decorative stroke travels. Buttons, selection and focus are already final. */
export function moveRailMarker(previous: HTMLElement | null, current: HTMLElement | null) {
  const from = previous?.isConnected ? previous.getBoundingClientRect() : null;
  previous?.getAnimations().forEach(animation => animation.cancel());
  if (!current || previous === current) return;
  const list = current.closest("ul");
  const button = current.closest("button");
  if (!list || !button) return;

  // A shortcut or a deep link can select a destination outside the scrollable strip.
  const clip = list.getBoundingClientRect();
  const target = button.getBoundingClientRect();
  const dx = Math.min(0, target.left - clip.left) + Math.max(0, target.right - clip.right);
  const dy = Math.min(0, target.top - clip.top) + Math.max(0, target.bottom - clip.bottom);
  if (dx || dy) {
    list.scrollBy({ left: dx, top: dy, behavior: "instant" });
    return;
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  if (reduced.matches || !from || previous?.closest("ul") !== list ||
      from.top < clip.top || from.bottom > clip.bottom || from.left < clip.left || from.right > clip.right) return;
  const to = current.getBoundingClientRect();
  const animation = current.animate([
    { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` },
    { transform: "none" },
  ], { duration: 185, easing: "cubic-bezier(.22,.8,.28,1)" });
  const listeners = new AbortController();
  const stop = () => animation.cancel();
  reduced.addEventListener("change", stop, { signal: listeners.signal });
  list.addEventListener("scroll", stop, { signal: listeners.signal, passive: true });
  window.addEventListener("resize", stop, { signal: listeners.signal });
  void animation.finished.then(() => listeners.abort(), () => listeners.abort());
}
