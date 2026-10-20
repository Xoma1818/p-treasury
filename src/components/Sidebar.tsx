import { SECTIONS, type SectionId } from "../lib/sections";
import { useUi } from "../lib/store";
import { HideAmountsButton } from "./Convenience";

// Значки разделов: линии 1.8 px в квадрате 24×24, цвет берётся от текста пункта.
const ICONS: Record<SectionId, string> = {
  home: "M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z",
  transactions: "M7 7h13M7 7l3-3M7 7l3 3M17 17H4m13 0l-3-3m3 3l-3 3",
  budget: "M12 3a9 9 0 1 0 9 9h-9z M15 3.5A9 9 0 0 1 20.5 9H15z",
  reports: "M5 20V10M12 20V4M19 20v-7",
  accounts: "M3 7h18v12H3z M3 11h18 M7 15h3",
  categories: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  debts: "M4 12h16M4 12l4-4M4 12l4 4M20 6v12",
  calendar: "M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4",
  notes: "M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h5",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M19.4 13a7.5 7.5 0 0 0 0-2l2-1.5-2-3.5-2.4 1a7.5 7.5 0 0 0-1.7-1L15 3.5h-4l-.3 2.5a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.5 2 1.5a7.5 7.5 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7.5 7.5 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.5z",
};

/** Логотип «Дверца сейфа» (src-tauri/icons/icon.svg) для шапки меню. */
function Logo() {
  return (
    <svg className="brand-logo" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#2F5FD0" />
      <rect x="14" y="12" width="40" height="40" rx="7" stroke="#fff" strokeWidth="4.5" fill="none" />
      <rect x="9" y="19" width="6" height="7" rx="1.5" fill="#fff" />
      <rect x="9" y="38" width="6" height="7" rx="1.5" fill="#fff" />
      <circle cx="34" cy="32" r="9" stroke="#fff" strokeWidth="4.5" fill="none" />
      <path d="M34 32V25" stroke="#fff" strokeWidth="4" strokeLinecap="round" />
    </svg>
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
          <li key={s.id}>
            <button
              className={s.id === section ? "nav-item active" : "nav-item"}
              aria-current={s.id === section ? "page" : undefined}
              onClick={() => go(s.id)}
              title={i < 9 ? `Ctrl+${i + 1}` : undefined}
            >
              <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d={ICONS[s.id]} />
              </svg>
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
