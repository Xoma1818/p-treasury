import { useQuery } from "@tanstack/react-query";
import { ChartColumn, Keyboard, ListFilter, Monitor, Moon, Search, Star, Sun } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../lib/api";
import { comboFor, useKeyMap } from "../lib/keymap";
import { useModules } from "../lib/modules";
import { isDefaultNav, navSections, useNavPrefs } from "../lib/navLayout";
import type { Section } from "../lib/sections";
import { useUi } from "../lib/store";
import { applyTheme, savedTheme, THEME_EVENT, type Theme } from "../lib/theme";
import { Brand } from "./Brand";
import { HideAmountsSwitch } from "./Convenience";
import { DecorativeIcon } from "./DecorativeIcon";
import { RailMenu, RailTooltip } from "./RailOverlays";
import { SectionIcon } from "./SectionIcon";

const THEMES = {
  light: { label: "Светлая", icon: Sun },
  dark: { label: "Тёмная", icon: Moon },
  system: { label: "Как в системе", icon: Monitor },
} as const;

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  useEffect(() => {
    const onTheme = (event: Event) => setTheme((event as CustomEvent<Theme>).detail);
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);
  const pick = (value: Theme) => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.documentElement.classList.add("theme-fade");
      window.setTimeout(() => document.documentElement.classList.remove("theme-fade"), 300);
    }
    applyTheme(value);
  };
  const current = THEMES[theme];
  return (
    <RailMenu label={`Тема: ${current.label}`} className="foot-btn rail-theme-trigger" testId="theme-switch"
      icon={<DecorativeIcon icon={current.icon} className="foot-icon" size="control" />}
      choices={(Object.keys(THEMES) as Theme[]).map(value => ({
        id: value, name: THEMES[value].label, icon: <DecorativeIcon icon={THEMES[value].icon} size="control" />,
        checked: theme === value, testId: `theme-${value}`, pick: () => pick(value),
      }))} />
  );
}

function NavViews() {
  const views = useQuery({ queryKey: ["views", "all"], queryFn: () => api.listViews(null) }).data ?? [];
  const openView = useUi(s => s.openView);
  if (views.length === 0) return null;
  return (
    <li className="nav-views" data-testid="nav-views">
      <RailMenu label="Мои виды" className="nav-item rail-views-trigger" testId="open-nav-views"
        icon={<DecorativeIcon icon={Star} />}
        choices={views.map(view => ({
          id: view.id, name: view.name, pick: () => openView(view),
          icon: <DecorativeIcon icon={view.kind === "report" ? ChartColumn : ListFilter} size="control" />,
        }))} />
    </li>
  );
}

export function Sidebar() {
  const { section, go, setHelp, setPalette } = useUi();
  const { sectionOn } = useModules();
  const { nav } = useNavPrefs();
  const keys = useKeyMap();
  const rail = useRef<HTMLElement>(null);
  const shown = navSections(nav, sectionOn);
  const groups = isDefaultNav(nav);
  const settings = shown.find(item => item.id === "settings");
  const sectionButton = (item: Section, index: number) => (
    <button type="button" className={item.id === section ? "nav-item active" : "nav-item"}
      aria-current={item.id === section ? "page" : undefined} aria-label={item.title}
      data-section={item.id} data-rail-tip={item.title} data-rail-key={index < 9 ? `Ctrl+${index + 1}` : undefined}
      style={{ "--rail-color": item.color } as CSSProperties} onClick={() => go(item.id)}>
      <SectionIcon id={item.id} />
      <span className="sr-only">{item.title}</span>
    </button>
  );
  return (
    <nav ref={rail} className="sidebar app-nav" aria-label="Разделы">
      <Brand iconOnly />
      <button type="button" className="nav-search" aria-label="Поиск" data-rail-tip="Поиск" data-rail-key={comboFor(keys, "palette")}
        onClick={() => setPalette(true)} data-testid="open-palette">
        <DecorativeIcon icon={Search} />
      </button>
      <ul data-testid="nav-list">
        {nav.viewsTop && <NavViews />}
        {shown.filter(item => item.id !== "settings").map((item, i) => (
          <li key={item.id} className={groups && i > 0 && shown[i - 1].group !== item.group ? "nav-break" : undefined}>
            {sectionButton(item, i)}
          </li>
        ))}
        {!nav.viewsTop && <NavViews />}
      </ul>
      {settings && <div className="nav-settings">{sectionButton(settings, shown.indexOf(settings))}</div>}
      <div className="sidebar-foot">
        <ThemeSwitch />
        <HideAmountsSwitch shortcut={comboFor(keys, "hideAmounts")} />
        <button type="button" className="foot-btn" onClick={() => setHelp(true)} aria-label="Горячие клавиши"
          data-rail-tip="Горячие клавиши" data-rail-key={comboFor(keys, "help")} data-testid="hotkeys-open">
          <DecorativeIcon icon={Keyboard} className="foot-icon" size="control" />
        </button>
      </div>
      <RailTooltip rail={rail} />
    </nav>
  );
}
