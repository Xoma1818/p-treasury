// Реестр горячих клавиш: по нему работает справка (F1). Сами сочетания
// обрабатываются в App (разделы и действия из lib/keymap.ts) и в UndoBar (Ctrl+Z / Ctrl+Y).
import { comboFor, KEY_ACTIONS, type KeyMap } from "./keymap";

/** Закреплённые сочетания; свои (переназначаемые) добавляет `hotkeyList`. */
export const HOTKEYS: [keys: string, action: string][] = [
  ["Ctrl+Enter", "Сохранить форму"],
  ["Ctrl+1 … Ctrl+9", "Разделы меню по порядку"],
  ["Ctrl+A", "В Операциях: выделить всё найденное"],
  ["Shift+щелчок", "В Операциях: выделить строки подряд (Ctrl+щелчок — по одной)"],
  ["Ctrl+Z", "Отменить последнее действие"],
  ["Ctrl+Y", "Повторить отменённое"],
  ["Ctrl+Alt+P", "Быстрый ввод из любой программы (меняется в Настройках)"],
  ["Esc", "Закрыть окно"],
];

/** Справка целиком: свои сочетания (как назначены сейчас) и закреплённые. */
export function hotkeyList(m: KeyMap): [keys: string, action: string][] {
  const own = KEY_ACTIONS.map((a) => [comboFor(m, a.id), a.label] as [string, string]).filter(([k]) => k);
  return [...own, ...HOTKEYS];
}

/** Фокус в поле ввода: там Ctrl+Z и другие сочетания работают как обычно в тексте. */
export function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(target.type);
}
