// Реестр горячих клавиш: по нему работает справка (F1). Сами сочетания
// обрабатываются в App (разделы, формы, поиск, «скрыть суммы») и в UndoBar (Ctrl+Z / Ctrl+Y).
export const HOTKEYS: [keys: string, action: string][] = [
  ["Ctrl+N", "Новая операция (расход)"],
  ["Ctrl+T", "Новый перевод"],
  ["Ctrl+Enter", "Сохранить форму"],
  ["Ctrl+F", "Поиск по операциям (в Заметках — по заметкам)"],
  ["Ctrl+1 … Ctrl+9", "Разделы меню по порядку"],
  ["Ctrl+Z", "Отменить последнее действие"],
  ["Ctrl+Y", "Повторить отменённое"],
  ["Ctrl+H", "Скрыть или показать суммы"],
  ["Ctrl+Alt+P", "Быстрый ввод из любой программы (меняется в Настройках)"],
  ["Esc", "Закрыть окно"],
  ["F1", "Эта справка"],
];

/** Фокус в поле ввода: там Ctrl+Z и другие сочетания работают как обычно в тексте. */
export function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(target.type);
}
