import { useQuery } from "@tanstack/react-query";
import { Keyboard, Moon, Search, Star, Sun } from "lucide-react";
import { Fragment, useState } from "react";
import { api } from "../lib/api";
import { SECTIONS } from "../lib/sections";
import { useUi } from "../lib/store";
import { applyTheme, savedTheme, type Theme } from "../lib/theme";
import { HideAmountsSwitch } from "./Convenience";
import { SectionIcon } from "./SectionIcon";

/** Логотип «Дверца сейфа» (src-tauri/icons/icon.svg); цвета берутся из темы. */
function Logo() {
  return (
    <svg className="brand-logo" viewBox="0 0 64 64" aria-hidden="true">
      <rect className="logo-bg" x="2" y="2" width="60" height="60" rx="14" />
      <g className="logo-fg" fill="none" strokeWidth="4.5">
        <rect x="14" y="12" width="40" height="40" rx="7" />
        <circle cx="34" cy="32" r="9" />
        <path d="M34 32V25" strokeWidth="4" strokeLinecap="round" />
      </g>
      <rect className="logo-hinge" x="9" y="19" width="6" height="7" rx="1.5" />
      <rect className="logo-hinge" x="9" y="38" width="6" height="7" rx="1.5" />
    </svg>
  );
}

/** Тема: «Светлая» или «Тёмная», выбранная подсвечена. */
function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  // Смена темы — мягкое перетекание цветов (View Transitions в WebView2), а не мигание.
  const pick = (t: Theme) => {
    const swap = () => (applyTheme(t), setTheme(t));
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(swap);
    else swap();
  };
  return (
    <div className="theme-switch" role="group" aria-label="Тема" data-testid="theme-switch">
      <button aria-pressed={theme === "light"} data-testid="theme-light" onClick={() => pick("light")}>
        <Sun className="foot-icon" strokeWidth={1.75} aria-hidden="true" />
        Светлая
      </button>
      <button aria-pressed={theme === "dark"} data-testid="theme-dark" onClick={() => pick("dark")}>
        <Moon className="foot-icon" strokeWidth={1.75} aria-hidden="true" />
        Тёмная
      </button>
    </div>
  );
}

/** Сохранённые виды операций и отчётов: открываются одним нажатием из меню. */
function NavViews() {
  const views = useQuery({ queryKey: ["views", "all"], queryFn: () => api.listViews(null) }).data ?? [];
  const openView = useUi((s) => s.openView);
  if (views.length === 0) return null;
  return (
    <li className="nav-views" data-testid="nav-views">
      <div className="nav-group">Мои виды</div>
      <ul>
        {views.map((v) => (
          <li key={v.id}>
            <button className="nav-item nav-view" onClick={() => openView(v)} title={v.kind === "report" ? "Открыть отчёт" : "Открыть операции с этим фильтром"}>
              <Star className="nav-view-mark" strokeWidth={1.75} aria-hidden="true" />
              {v.name}
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function Sidebar() {
  const { section, go, setHelp, setPalette } = useUi();
  return (
    <nav className="sidebar" aria-label="Разделы">
      <div className="brand">
        <Logo />
        P-Treasury
      </div>
      <button className="nav-search" onClick={() => setPalette(true)} data-testid="open-palette">
        <Search strokeWidth={1.75} aria-hidden="true" />
        <span>Поиск</span>
        <kbd>Ctrl+K</kbd>
      </button>
      <ul>
        {SECTIONS.map((s, i) => (
          <Fragment key={s.id}>
            {s.id === "settings" && <NavViews />}
            <li className={s.id === "settings" ? "nav-settings" : undefined}>
              {s.group && SECTIONS[i - 1]?.group !== s.group && <div className="nav-group">{s.group}</div>}
              <button
                className={s.id === section ? "nav-item active" : "nav-item"}
                aria-current={s.id === section ? "page" : undefined}
                onClick={() => go(s.id)}
                title={i < 9 ? `${s.hint} · Ctrl+${i + 1}` : s.hint}
              >
                <SectionIcon id={s.id} />
                {s.title}
                {/* Номер для Ctrl+цифра рисует CSS, чтобы он не попадал в текст кнопки. */}
                {i < 9 && <span className="nav-key" data-k={i + 1} aria-hidden="true" />}
              </button>
            </li>
          </Fragment>
        ))}
      </ul>
      <div className="sidebar-foot">
        <ThemeSwitch />
        <HideAmountsSwitch />
        <button className="foot-row" onClick={() => setHelp(true)} title="F1" data-testid="hotkeys-open">
          <Keyboard className="foot-icon" strokeWidth={1.75} aria-hidden="true" />
          <span className="foot-label">Горячие клавиши</span>
          <kbd>F1</kbd>
        </button>
      </div>
    </nav>
  );
}
