import { useEffect } from "react";
import { FORM_KEY, notifyForm } from "./lib/txnFormPrefs";
import { ADD_KEY, NAV_KEY, navSections, notifyNav, savedNav } from "./lib/navLayout";
import { loadPrefs, prefsToApply } from "./lib/uiPrefs";
import { applyTheme, savedTheme } from "./lib/theme";
import { applyScale, savedScale } from "./lib/scale";
import { useModules } from "./lib/modules";
import { ContextMenuHost } from "./components/ContextMenu";
import { AutoRates } from "./components/AutoRates";
import { DemoBanner } from "./components/DemoBanner";
import { MissedReminders } from "./components/MissedReminders";
import { Palette } from "./components/Palette";
import { HotkeysHelp, UndoBar } from "./components/Convenience";
import { UpdatePrompt } from "./components/DataTools";
import { Sidebar } from "./components/Sidebar";
import { TxnForm } from "./components/TxnForm";
import { api, isTauri } from "./lib/api";
import { useAppInfo, useSettings } from "./lib/queries";
import { useAction } from "./lib/useAction";
import { type SectionId } from "./lib/sections";
import { useUi } from "./lib/store";
import { Accounts } from "./screens/Accounts";
import { Budget } from "./screens/Budget";
import { Calendar } from "./screens/Calendar";
import { Categories } from "./screens/Categories";
import { Debts } from "./screens/Debts";
import { Forecast } from "./screens/Forecast";
import { Home } from "./screens/Home";
import { Notes } from "./screens/Notes";
import { Onboarding } from "./screens/Onboarding";
import { Placeholder } from "./screens/Placeholder";
import { Reports } from "./screens/Reports";
import { Settings } from "./screens/Settings";
import { Transactions } from "./screens/Transactions";

const SCREENS: Partial<Record<SectionId, () => React.JSX.Element>> = {
  home: Home,
  transactions: Transactions,
  budget: Budget,
  reports: Reports,
  forecast: Forecast,
  accounts: Accounts,
  categories: Categories,
  debts: Debts,
  calendar: Calendar,
  notes: Notes,
  settings: Settings,
};

/** Ctrl+F: поле поиска на текущем экране, а если его нет — поиск в Операциях. */
function focusSearch(go: (s: SectionId) => void) {
  const field = () => document.querySelector<HTMLInputElement>("main [data-search]");
  if (field()) return field()!.focus();
  go("transactions");
  // Экран откроется на следующей отрисовке.
  let tries = 0;
  const wait = () => (field() ? field()!.focus() : ++tries < 20 && setTimeout(wait, 50));
  setTimeout(wait, 0);
}

export function App() {
  const info = useAppInfo();
  const { section, visit, go, openTxnForm, help, setHelp, palette, setPalette } = useUi();
  const hidden = useSettings().data?.hide_amounts === "1";
  const setSetting = useAction(api.setSetting);
  // Г13: настройки вида — копия в базе; после восстановления копии берём их оттуда.
  const settingsData = useSettings().data;
  // Копия вида в базе: при запуске и после восстановления копии в открытой программе.
  useEffect(() => {
    if (!settingsData) return;
    const raw = settingsData.ui_prefs;
    if (!prefsToApply(raw)) return;
    const restored = loadPrefs(raw);
    if (restored.includes("p-treasury-theme")) applyTheme(savedTheme());
    if (restored.includes("p-treasury-scale")) applyScale(savedScale());
    if (restored.some((k) => k === NAV_KEY || k === ADD_KEY)) notifyNav();
    if (restored.includes(FORM_KEY)) notifyForm();
  }, [settingsData]);
  // Г3: выключенный модуль — его раздел недоступен; если он открыт, возвращаемся на Главную.
  const { sectionOn } = useModules();
  const sectionHidden = !sectionOn(section);
  useEffect(() => {
    if (sectionHidden) go("home");
  }, [sectionHidden, go]);

  // Ctrl+1…9: разделы меню; Ctrl+N: новая операция; Ctrl+T: перевод; Ctrl+F: поиск;
  // Ctrl+K: поиск по всему; Ctrl+H: скрыть суммы; F1: справка. Полный список — lib/hotkeys.ts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F1") {
        e.preventDefault();
        setHelp(true);
        return;
      }
      if (!e.ctrlKey || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      const menu = navSections(savedNav(), sectionOn);
      if (n >= 1 && n <= 9 && menu[n - 1]) {
        e.preventDefault();
        go(menu[n - 1].id);
      } else if (e.code === "KeyN") {
        e.preventDefault();
        openTxnForm({ mode: "new", type: "expense" });
      } else if (e.code === "KeyT") {
        e.preventDefault();
        openTxnForm({ mode: "new", type: "transfer" });
      } else if (e.code === "KeyH") {
        e.preventDefault();
        setSetting.run("hide_amounts", hidden ? "0" : "1");
      } else if (e.code === "KeyK") {
        e.preventDefault();
        setPalette(true);
      } else if (e.code === "KeyF") {
        e.preventDefault();
        focusSearch(go);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, openTxnForm, setHelp, setPalette, hidden, setSetting.run]);

  if (!isTauri()) {
    return <div className="wizard"><div className="card wizard-card">Kazna работает как приложение для ПК. Откройте его через установленную программу.</div></div>;
  }
  if (info.error) {
    return (
      <div className="wizard">
        <div className="card wizard-card">
          <h1>Не удалось открыть данные</h1>
          <p className="error">{String(info.error)}</p>
        </div>
      </div>
    );
  }
  if (!info.data) return null;
  if (!info.data.onboardingDone) return <Onboarding />;

  const Screen = SCREENS[section];
  return (
    <div className="layout">
      <Sidebar />
      <main className="content">
        <DemoBanner />
        {Screen ? <Screen key={visit} /> : <Placeholder id={section} />}
      </main>
      <AutoRates />
      <MissedReminders />
      <UpdatePrompt />
      <UndoBar />
      {help && <HotkeysHelp onClose={() => setHelp(false)} />}
      {palette && <Palette />}
      <TxnForm />
      <ContextMenuHost />
    </div>
  );
}
