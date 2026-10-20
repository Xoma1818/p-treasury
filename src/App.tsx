import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { TxnForm } from "./components/TxnForm";
import { isTauri } from "./lib/api";
import { useAppInfo } from "./lib/queries";
import { SECTIONS, type SectionId } from "./lib/sections";
import { useUi } from "./lib/store";
import { Accounts } from "./screens/Accounts";
import { Budget } from "./screens/Budget";
import { Categories } from "./screens/Categories";
import { Home } from "./screens/Home";
import { Onboarding } from "./screens/Onboarding";
import { Placeholder } from "./screens/Placeholder";
import { Settings } from "./screens/Settings";
import { Transactions } from "./screens/Transactions";

const SCREENS: Partial<Record<SectionId, () => React.JSX.Element>> = {
  home: Home,
  transactions: Transactions,
  budget: Budget,
  accounts: Accounts,
  categories: Categories,
  settings: Settings,
};

export function App() {
  const info = useAppInfo();
  const { section, go, openTxnForm } = useUi();

  // Ctrl+1…9: разделы меню; Ctrl+N: новая операция; Ctrl+T: перевод.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && SECTIONS[n - 1]) {
        e.preventDefault();
        go(SECTIONS[n - 1].id);
      } else if (e.code === "KeyN") {
        e.preventDefault();
        openTxnForm({ mode: "new", type: "expense" });
      } else if (e.code === "KeyT") {
        e.preventDefault();
        openTxnForm({ mode: "new", type: "transfer" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, openTxnForm]);

  if (!isTauri()) {
    return <div className="wizard"><div className="card wizard-card">Казна работает как приложение для ПК. Откройте её через установленную программу.</div></div>;
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
      <main className="content">{Screen ? <Screen /> : <Placeholder id={section} />}</main>
      <TxnForm />
    </div>
  );
}
