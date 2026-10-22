import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api } from "../lib/api";
import { addTag, tagSuggestions } from "../lib/tags";

/** Поле «Теги» (Г6): значки выбранных тегов, подсказка по существующим, новый — по Enter. */
export function TagInput({ id, value, onChange }: { id?: string; value: string[]; onChange: (tags: string[]) => void }) {
  const all = useQuery({ queryKey: ["tags"], queryFn: api.listTags }).data ?? [];
  const [text, setText] = useState("");
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(0);
  // Стрелками выбрали подсказку: Enter берёт её, иначе — набранный текст как новый тег.
  const [picked, setPicked] = useState(false);
  const listId = useId();
  const hints = focus ? tagSuggestions(all.map((t) => t.name), text, value) : [];
  const add = (name: string) => {
    onChange(addTag(value, name));
    setText("");
    setActive(0);
    setPicked(false);
  };
  return (
    <div className="tag-input" data-testid="tag-input">
      {value.map((t) => (
        <span key={t} className="tag-chip removable">
          #{t}
          <button type="button" aria-label={`Убрать тег ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
            ✕
          </button>
        </span>
      ))}
      <input
        id={id}
        name="tags"
        autoComplete="off"
        placeholder={value.length ? "" : "ремонт, дача, отпуск…"}
        value={text}
        role="combobox"
        aria-expanded={hints.length > 0}
        aria-controls={listId}
        onFocus={() => setFocus(true)}
        // Задержка: щелчок по подсказке успевает сработать до скрытия списка.
        onBlur={() => window.setTimeout(() => setFocus(false), 120)}
        onChange={(e) => (setText(e.target.value), setActive(0), setPicked(false))}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === ",") && !e.ctrlKey) {
            if (!text.trim() && e.key === "Enter") return; // пустое поле: Enter сохраняет форму
            e.preventDefault();
            add(picked && hints[active] ? hints[active] : text);
          } else if (e.key === "Backspace" && !text && value.length) {
            onChange(value.slice(0, -1));
          } else if (e.key === "ArrowDown" && hints.length) {
            e.preventDefault();
            setActive((a) => (picked ? Math.min(hints.length - 1, a + 1) : 0));
            setPicked(true);
          } else if (e.key === "ArrowUp" && hints.length) {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
            setPicked(true);
          } else if (e.key === "Tab" && text.trim() && hints[active]) {
            e.preventDefault();
            add(hints[active]);
          }
        }}
      />
      {hints.length > 0 && (
        <ul className="tag-hints" id={listId} role="listbox">
          {hints.map((h, i) => (
            <li key={h} role="option" aria-selected={picked && i === active} onMouseDown={(e) => (e.preventDefault(), add(h))} onMouseMove={() => (setActive(i), setPicked(true))}>
              #{h}
              <span className="muted">{all.find((t) => t.name === h)?.count ?? 0}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
