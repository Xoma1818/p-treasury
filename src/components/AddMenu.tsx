import { ChevronDown } from "lucide-react";
import { useNavPrefs, type AddMain } from "../lib/navLayout";
import { useUi } from "../lib/store";
import { usePopup } from "../lib/usePopup";

export const ADD_TYPES: AddMain[] = ["expense", "income", "transfer"];
export const ADD_LABEL: Record<AddMain, string> = { expense: "+ Расход", income: "+ Доход", transfer: "Перевод" };
const HOTKEY: Record<AddMain, string | undefined> = { expense: "Ctrl+N", income: undefined, transfer: "Ctrl+T" };

/** Шапка Главной (п. 1 плана): одна мятная «+ Расход», доход и перевод — в меню ▾.
 *  Меню закрывается по Esc, щелчку мимо и после выбора пункта. */
export function AddMenu() {
  const openTxnForm = useUi((s) => s.openTxnForm);
  const { open, setOpen, ref } = usePopup();
  // Г6: что выполняет сама кнопка, выбирается в Настройках; остальное — в меню ▾.
  const { addMain } = useNavPrefs();
  const pick = (type: AddMain) => {
    setOpen(false);
    openTxnForm({ mode: "new", type });
  };
  return (
    <div className="split-btn" ref={ref} data-testid="add-menu">
      <button className="btn primary" onClick={() => openTxnForm({ mode: "new", type: addMain })} title={HOTKEY[addMain]} data-testid="add-main">
        {ADD_LABEL[addMain]}
      </button>
      <button
        className="btn primary split-toggle"
        aria-label="Другие операции"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="add-menu-toggle"
        onClick={() => setOpen(!open)}
      >
        <ChevronDown size={16} aria-hidden />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {ADD_TYPES.filter((t) => t !== addMain).map((t) => (
            <button key={t} role="menuitem" className="menu-item" onClick={() => pick(t)}>
              {ADD_LABEL[t]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
