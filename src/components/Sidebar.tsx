import { useQuery } from "@tanstack/react-query";
import { isDefaultNav, navSections, useNavPrefs } from "../lib/navLayout";
import { useModules } from "../lib/modules";
import { Keyboard, Monitor, Moon, Search, Star, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useUi } from "../lib/store";
import { applyTheme, savedTheme, THEME_EVENT, type Theme } from "../lib/theme";
import { HideAmountsSwitch } from "./Convenience";
import { SectionIcon } from "./SectionIcon";
import { DecorativeIcon } from "./DecorativeIcon";
import { Brand } from "./Brand";
import type { Section } from "../lib/sections";

/** Ручные темы и режим, который следует оформлению системы. */
function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  useEffect(() => {
    const on = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener(THEME_EVENT, on);
    return () => window.removeEventListener(THEME_EVENT, on);
  }, []);
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
      <button aria-pressed={theme === "light"} data-testid="theme-light" title="Светлая тема" onClick={() => pick("light")}>
        <DecorativeIcon icon={Sun} className="foot-icon" size="control" />
        <span className="sr-only">Светлая</span>
      </button>
      <button aria-pressed={theme === "dark"} data-testid="theme-dark" title="Тёмная тема" onClick={() => pick("dark")}>
        <DecorativeIcon icon={Moon} className="foot-icon" size="control" />
        <span className="sr-only">Тёмная</span>
      </button>
      <button aria-pressed={theme === "system"} data-testid="theme-system" title="Как в системе" onClick={() => pick("system")}>
        <DecorativeIcon icon={Monitor} className="foot-icon" size="control" />
        <span className="sr-only">Как в системе</span>
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
              <DecorativeIcon icon={Star} className="nav-view-mark" />
              <span className="nav-view-name">{v.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function Sidebar() {
  const { section, go, setHelp, setPalette } = useUi();
  const { sectionOn } = useModules();
  const { nav } = useNavPrefs();
  const shown = navSections(nav, sectionOn);
  const groups = isDefaultNav(nav);
  const settings = shown.find((item) => item.id === "settings");
  const sectionButton = (item: Section, index: number) => (
    <button
      className={item.id === section ? "nav-item active" : "nav-item"}
      aria-current={item.id === section ? "page" : undefined}
      onClick={() => go(item.id)}
      title={index < 9 ? `${item.hint} · Ctrl+${index + 1}` : item.hint}
    >
      <SectionIcon id={item.id} />
      {item.title}
    </button>
  );
  return (
    <nav className="sidebar app-nav" aria-label="Разделы">
      <Brand />
      <button className="nav-search" onClick={() => setPalette(true)} data-testid="open-palette">
        <DecorativeIcon icon={Search} size="inline" />
        <span>Поиск</span>
        <kbd>Ctrl+K</kbd>
      </button>
      <ul data-testid="nav-list">
        {nav.viewsTop && <NavViews />}
        {shown.filter((item) => item.id !== "settings").map((item, i) => (
          <li key={item.id} className={groups && i > 0 && shown[i - 1].group !== item.group ? "nav-break" : undefined}>
            {sectionButton(item, i)}
          </li>
        ))}
        {!nav.viewsTop && <NavViews />}
      </ul>
      {settings && <div className="nav-settings">{sectionButton(settings, shown.indexOf(settings))}</div>}
      {/* Нижний ряд (0.28): тема, скрыть суммы и горячие клавиши — одной строкой, чтобы меню помещалось в окно высотой 800 px. */}
      <div className="sidebar-foot">
        <ThemeSwitch />
        <span className="foot-spacer" />
        <HideAmountsSwitch />
        <button className="foot-btn" onClick={() => setHelp(true)} title="Горячие клавиши · F1" aria-label="Горячие клавиши" data-testid="hotkeys-open">
          <DecorativeIcon icon={Keyboard} className="foot-icon" size="control" />
        </button>
      </div>
    </nav>
  );
}
