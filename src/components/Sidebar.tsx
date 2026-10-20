import { SECTIONS } from "../lib/sections";
import { useUi } from "../lib/store";

export function Sidebar() {
  const { section, go } = useUi();
  return (
    <nav className="sidebar" aria-label="Разделы">
      <div className="brand">Казна</div>
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
    </nav>
  );
}
