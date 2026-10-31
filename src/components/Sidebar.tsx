import { useQuery } from "@tanstack/react-query";
import { Keyboard, Moon, Search, Star, Sun } from "lucide-react";
import { Fragment, useState } from "react";
import { api } from "../lib/api";
import { SECTIONS } from "../lib/sections";
import { useUi } from "../lib/store";
import { applyTheme, savedTheme, type Theme } from "../lib/theme";
import { HideAmountsSwitch } from "./Convenience";
import { SectionIcon } from "./SectionIcon";

/** Логотип «Дверца, тише» (src-tauri/icons/icon.svg): мятный в обеих темах, как значок в Windows. */
function Logo() {
  return (
    <svg className="brand-logo" viewBox="0 0 64 64" aria-hidden="true">
      <rect className="logo-bg" x="2" y="2" width="60" height="60" rx="16" />
      <g className="logo-fg" fill="none" strokeWidth="3.5" strokeLinecap="round">
        <rect x="15" y="15" width="34" height="34" rx="8" />
        <circle cx="32" cy="32" r="7" />
        <path d="M32 32v-5.5" />
      </g>
    </svg>
  );
}

/** Тема: «Светлая» или «Тёмная», выбранная подсвечена. */
function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  // Смена темы — мягкое перетекание цветов (класс theme-fade на 300 мс), а не мигание.
  // Тема ставится сразу: анимация только у цветов. При «меньше движения» — без перетекания.
  const pick = (t: Theme) => {
    const root = document.documentElement;
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      root.classList.add("theme-fade");
      window.setTimeout(() => root.classList.remove("theme-fade"), 300);
    }
    applyTheme(t);
    setTheme(t);
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
        Kazna
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
