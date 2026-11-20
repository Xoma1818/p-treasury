import { useUi } from "./store";

// Вводный эффект карточек и календаря включён только при первом открытии раздела.
// При повторном посещении CSS видит data-seen и сразу показывает элементы.
export function installSeenSections() {
  const seen = new Set([useUi.getState().section]);
  const root = document.documentElement;
  useUi.subscribe((s, prev) => {
    if (s.section === prev.section && s.visit === prev.visit) return;
    root.toggleAttribute("data-seen", seen.has(s.section));
    seen.add(s.section);
  });
}
