// Разделы бокового меню. Порядок задаёт Ctrl+1…9, группы — подписи в меню.
// color — прежний цвет значка раздела (до 0.25); с «Лаконичного» значки одноцветные и цвет не рисуется.
export const SECTIONS = [
  { id: "home", title: "Главная", group: "Каждый день", hint: "Баланс, месяц и ближайшие дела", color: "#5eead4", stage: 1 },
  { id: "transactions", title: "Операции", group: "Каждый день", hint: "Все доходы, расходы и переводы", color: "#60a5fa", stage: 1 },
  { id: "calendar", title: "Календарь", group: "Каждый день", hint: "Платежи и напоминания по дням", color: "#f472b6", stage: 5 },
  { id: "budget", title: "Бюджет", group: "Планы", hint: "Сколько можно тратить в этом месяце", color: "#a78bfa", stage: 2 },
  { id: "reports", title: "Отчёты", group: "Планы", hint: "Куда уходят деньги и что изменилось", color: "#facc15", stage: 3 },
  { id: "forecast", title: "Взгляд вперёд", group: "Планы", hint: "Сколько денег будет через год и что, если что-то изменится", color: "#818cf8", stage: 7 },
  { id: "accounts", title: "Счета", group: "Деньги", hint: "Карты, наличные и вклады", color: "#34d399", stage: 1 },
  { id: "debts", title: "Займы и долги", group: "Деньги", hint: "Кому вы должны и кто должен вам, кредиты и график платежей", color: "#fb923c", stage: 4 },
  { id: "categories", title: "Категории", group: "Справочники", hint: "Статьи доходов и расходов", color: "#38bdf8", stage: 1 },
  { id: "notes", title: "Заметки", group: "Справочники", hint: "Записи к дням, счетам и долгам", color: "#fda4af", stage: 5 },
  { id: "settings", title: "Настройки", group: "", hint: "Валюта, курсы, копии и обновления", color: "#9aa1ae", stage: 6 },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];
export type Section = (typeof SECTIONS)[number];

export function section(id: SectionId): Section {
  return SECTIONS.find((s) => s.id === id)!;
}
