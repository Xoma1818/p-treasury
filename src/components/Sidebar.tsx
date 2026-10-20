import { SECTIONS } from "../lib/sections";
import { useUi } from "../lib/store";
import { HideAmountsButton } from "./Convenience";

export function Sidebar() {
  const { section, go, setHelp } = useUi();
  return (
    <nav className="sidebar" aria-label="Разделы">
      <div className="brand">P-Treasury</div>
      <ul>
        {SECTIONS.map((s, i) => (
          <li key={s.id}>
            <button
              className={s.id === section ? "nav-item active" : "nav-item"}
              onClick={() => go(s.id)}
              title={i < 9 ? `Ctrl+${i + 1}` : undefined}
            >
              {s.title}
            </button>
          </li>
        ))}
      </ul>
      <div className="sidebar-foot">
        <HideAmountsButton />
        <button className="link" onClick={() => setHelp(true)} title="F1">
          Горячие клавиши
        </button>
      </div>
    </nav>
  );
}
