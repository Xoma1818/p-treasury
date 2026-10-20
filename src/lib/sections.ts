// Разделы бокового меню (design/README.md, стиль A). Порядок задаёт Ctrl+1…9.
export const SECTIONS = [
  { id: "home", title: "Главная", stage: 1 },
  { id: "transactions", title: "Операции", stage: 1 },
  { id: "budget", title: "Бюджет", stage: 2 },
  { id: "reports", title: "Отчёты", stage: 3 },
  { id: "accounts", title: "Счета", stage: 1 },
  { id: "categories", title: "Категории", stage: 1 },
  { id: "debts", title: "Долги", stage: 4 },
  { id: "calendar", title: "Календарь", stage: 5 },
  { id: "notes", title: "Заметки", stage: 5 },
  { id: "settings", title: "Настройки", stage: 6 },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];
