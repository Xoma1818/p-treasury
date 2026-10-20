import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { SECTIONS } from "./lib/sections";
import { useUi } from "./lib/store";
import { Placeholder } from "./screens/Placeholder";
import { Settings } from "./screens/Settings";

export function App() {
  const { section, go } = useUi();

  // Ctrl+1…9: переход по разделам меню.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && SECTIONS[n - 1]) {
        e.preventDefault();
        go(SECTIONS[n - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  return (
    <div className="layout">
      <Sidebar />
      <main className="content">{section === "settings" ? <Settings /> : <Placeholder id={section} />}</main>
    </div>
  );
}
