import { useQuery } from "@tanstack/react-query";
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

const SUN = "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4";

/** Тема: «Светлая» или «Тёмная», выбранная подсвечена. */
function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const pick = (t: Theme) => (applyTheme(t), setTheme(t));
  return (
    <div className="theme-switch" role="group" aria-label="Тема" data-testid="theme-switch">
      <button aria-pressed={theme === "light"} data-testid="theme-light" onClick={() => pick("light")}>
        <svg className="foot-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d={SUN} />
        </svg>
        Светлая
      </button>
      <button aria-pressed={theme === "dark"} data-testid="theme-dark" onClick={() => pick("dark")}>
        <svg className="foot-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
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
              <span className="nav-view-mark" aria-hidden="true">
                ☆
              </span>
              {v.name}
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function Sidebar() {
  const { section, go, setHelp } = useUi();
  return (
    <nav className="sidebar" aria-label="Разделы">
      <div className="brand">
        <Logo />
        P-Treasury
      </div>
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
                // Номер для Ctrl+цифра рисует CSS, чтобы он не попадал в текст кнопки.
                data-key={i < 9 ? i + 1 : undefined}
              >
                <SectionIcon id={s.id} />
                {s.title}
              </button>
            </li>
          </Fragment>
        ))}
      </ul>
      <div className="sidebar-foot">
        <ThemeSwitch />
        <HideAmountsSwitch />
        <button className="foot-row" onClick={() => setHelp(true)} title="F1" data-testid="hotkeys-open">
          <svg className="foot-icon" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="2" y="6" width="20" height="12" rx="2" />
            <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
          </svg>
          <span className="foot-label">Горячие клавиши</span>
          <kbd>F1</kbd>
        </button>
      </div>
    </nav>
  );
}
