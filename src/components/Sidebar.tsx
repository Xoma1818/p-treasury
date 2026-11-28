import { useQuery } from "@tanstack/react-query";
import { ChartColumn, Keyboard, ListFilter, Monitor, Moon, Search, Star, Sun } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { api } from "../lib/api";
import { useModules } from "../lib/modules";
import { isDefaultNav, navSections, useNavPrefs } from "../lib/navLayout";
import type { Section } from "../lib/sections";
import { moveRailMarker } from "../lib/motion";
import { useUi } from "../lib/store";
import { applyTheme, THEME_LABELS, useTheme, type Theme } from "../lib/theme";
import { Brand } from "./Brand";
import { HideAmountsSwitch } from "./Convenience";
import { DecorativeIcon } from "./DecorativeIcon";
import { RailMenu, RailTooltip } from "./RailOverlays";
import { SectionIcon } from "./SectionIcon";

const themeIcons = { light: Sun, dark: Moon, system: Monitor } as const;

function ThemeSwitch() {
  const theme = useTheme();
  return (
    <RailMenu label={`Тема: ${THEME_LABELS[theme]}`} className="foot-btn rail-theme-trigger" testId="theme-switch"
      icon={<DecorativeIcon icon={themeIcons[theme]} className="foot-icon" size="control" />}
      choices={(Object.keys(THEME_LABELS) as Theme[]).map(value => ({
        id: value, name: THEME_LABELS[value], icon: <DecorativeIcon icon={themeIcons[value]} size="control" />,
        checked: theme === value, testId: `theme-${value}`, pick: () => applyTheme(value),
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
        icon={<><DecorativeIcon icon={Star} /><span className="rail-label">Мои виды</span></>}
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
  const rail = useRef<HTMLElement>(null);
  const previousMark = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const current = rail.current?.querySelector<HTMLElement>('[aria-current="page"] .rail-mark') ?? null;
    moveRailMarker(previousMark.current, current);
    previousMark.current = current;
  }, [section]);
  const shown = navSections(nav, sectionOn);
  const groups = isDefaultNav(nav);
  const settings = shown.find(item => item.id === "settings");
  const sectionButton = (item: Section) => (
    <button type="button" className={item.id === section ? "nav-item active" : "nav-item"}
      aria-current={item.id === section ? "page" : undefined} aria-label={item.title}
      data-section={item.id} data-rail-tip={item.title}
      onClick={() => { if (item.id !== section) go(item.id); }}>
      <SectionIcon id={item.id} />
      <span className="rail-label">{item.title}</span>
      <span className="rail-mark" aria-hidden="true" />
    </button>
  );
  return (
    <nav ref={rail} className="sidebar app-nav" aria-label="Разделы">
      <Brand />
      <button type="button" className="nav-search" aria-label="Поиск" data-rail-tip="Поиск"
        onClick={() => setPalette(true)} data-testid="open-palette">
        <DecorativeIcon icon={Search} />
      </button>
      <ul data-testid="nav-list">
        {nav.viewsTop && <NavViews />}
        {shown.filter(item => item.id !== "settings").map((item, i) => (
          <li key={item.id} className={groups && i > 0 && shown[i - 1].group !== item.group ? "nav-break" : undefined}>
            {sectionButton(item)}
          </li>
        ))}
        {!nav.viewsTop && <NavViews />}
      </ul>
      {settings && <div className="nav-settings">{sectionButton(settings)}</div>}
      <div className="sidebar-foot">
        <ThemeSwitch />
        <HideAmountsSwitch />
        <button type="button" className="foot-btn" onClick={() => setHelp(true)} aria-label="Горячие клавиши"
          data-rail-tip="Горячие клавиши" data-testid="hotkeys-open">
          <DecorativeIcon icon={Keyboard} className="foot-icon" size="control" />
        </button>
      </div>
      <RailTooltip rail={rail} />
    </nav>
  );
}
