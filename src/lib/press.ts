// Отклик на нажатие: от точки касания по кнопке расходится светлая волна.
// Координаты передаются в CSS (--px, --py), анимацию запускает атрибут data-pressed.
const PRESSABLE = ".btn, .chip-btn, .tab, .nav-item, .template-main";

export function installPressEffect(root: Document = document) {
  root.addEventListener("pointerdown", (e) => {
    const el = (e.target as Element | null)?.closest?.(PRESSABLE) as HTMLElement | null;
    if (!el || (el as HTMLButtonElement).disabled) return;
    const box = el.getBoundingClientRect();
    el.style.setProperty("--px", `${e.clientX - box.left}px`);
    el.style.setProperty("--py", `${e.clientY - box.top}px`);
    el.removeAttribute("data-pressed");
    void el.offsetWidth; // перезапуск анимации при быстрых повторных нажатиях
    el.setAttribute("data-pressed", "");
    window.setTimeout(() => el.removeAttribute("data-pressed"), 500);
  });
}
