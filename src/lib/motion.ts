import { useUi } from "./store";

// «Пружина» (0.25): графики, кольца и полосы растут только при первом открытии
// раздела за сеанс. При повторном открытии на <html> ставится data-seen, и CSS
// показывает их сразу.
export function installSeenSections() {
  const seen = new Set([useUi.getState().section]);
  const root = document.documentElement;
  useUi.subscribe((s, prev) => {
    if (s.section === prev.section && s.visit === prev.visit) return;
    root.toggleAttribute("data-seen", seen.has(s.section));
    seen.add(s.section);
  });
}
