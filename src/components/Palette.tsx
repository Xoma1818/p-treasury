import { useQuery } from "@tanstack/react-query";
import { useModules } from "../lib/modules";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type SearchHit } from "../lib/api";
import { formatDate } from "../lib/dates";
import { formatAmount } from "../lib/money";
import { useAccounts, useCategories } from "../lib/queries";
import { SECTIONS, type SectionId } from "../lib/sections";
import { useUi, type SettingsJump } from "../lib/store";
import { applyTheme, savedTheme } from "../lib/theme";
import { useAction } from "../lib/useAction";
import { useSettings } from "../lib/queries";
import { SectionIcon } from "./SectionIcon";

interface Item {
  key: string;
  group: string;
  title: string;
  detail?: string;
  section: SectionId;
  run: () => void;
  /** Другие слова, по которым находится пункт («тема», «тёмная»…). */
  words?: string;
}

/** Г1: любая настройка в двух нажатиях — раздел Настроек и поле в нём. */
const SETTINGS: { key: string; title: string; words: string; section: string; field?: string; dialog?: SettingsJump["dialog"] }[] = [
  { key: "base", title: "Основная валюта", words: "рубль валюта base", section: "general", field: "baseCurrency" },
  { key: "month", title: "Первый день месяца", words: "начало месяца зарплата", section: "general", field: "monthStartDay" },
  { key: "hints", title: "Подсказки «?»", words: "подсказки помощь", section: "general", field: "hints" },
  { key: "debtdays", title: "Напоминать о платеже по долгу", words: "долг займ напоминание", section: "general", field: "debtReminderDays" },
  { key: "subs", title: "Напоминать о регулярных платежах", words: "подписки напоминание", section: "general", field: "subsRemind" },
  { key: "txnopen", title: "Открывать операцию: панелью или окном", words: "панель окно операция", section: "general", field: "txnOpen" },
  { key: "date", title: "Формат даты", words: "дата формат", section: "general", field: "dateFormat" },
  { key: "scale", title: "Масштаб интерфейса", words: "размер шрифт крупнее", section: "general", field: "uiScale" },
  { key: "tray", title: "При закрытии окна", words: "трей закрытие свернуть", section: "general", field: "closeToTray" },
  { key: "hotkey", title: "Клавиша быстрого ввода", words: "горячая клавиша быстрый ввод", section: "general", field: "quickHotkey" },
  { key: "home", title: "Карточки Главной", words: "главная настроить блоки", section: "home" },
  { key: "modules", title: "Возможности: включить и выключить модули", words: "модули функции выключить инвестиции займы долги подписки привычки заметки поездки", section: "modules" },
  { key: "rates", title: "Курсы валют", words: "курс цб доллар евро", section: "rates" },
  { key: "summary", title: "Сводка в Excel", words: "выгрузить excel эксель отчёт", section: "data", dialog: "summary" },
  { key: "import", title: "Импорт выписки или CSV", words: "импорт загрузить выписка банк csv", section: "data", dialog: "import" },
  { key: "history", title: "История импорта", words: "импорт история загрузки", section: "data", dialog: "history" },
  { key: "vault", title: "Резервная копия и папка сохранности", words: "копия бэкап backup сохранность восстановить", section: "vault" },
  { key: "updates", title: "Обновления", words: "обновить версия", section: "updates" },
  { key: "about", title: "О программе", words: "версия файл данных", section: "about" },
];

const HIT_GROUP: Record<SearchHit["kind"], [string, SectionId]> = {
  note: ["Заметки", "notes"],
  event: ["Поездки и события", "budget"],
  debt: ["Займы и долги", "debts"],
  asset: ["Имущество", "accounts"],
  goal: ["Цели", "home"],
  tag: ["Теги", "transactions"],
};

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Поиск по всему (Ctrl+K): разделы, действия, счета, категории, виды,
 *  заметки, события, долги, цели и операции. Стрелки, Enter, Esc. */
export function Palette() {
  const { setPalette, go, showTransactions, openTxnForm, openDebt, openView, openReport, openSettings, setHelp } = useUi();
  const hidden = useSettings().data?.hide_amounts === "1";
  const setSetting = useAction(api.setSetting);
  const { sectionOn } = useModules();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [deb, setDeb] = useState("");
  const list = useRef<HTMLUListElement>(null);
  const accounts = useAccounts().data ?? [];
  const categories = useCategories().data ?? [];
  const views = useQuery({ queryKey: ["views", null], queryFn: () => api.listViews(null) }).data ?? [];
  useEffect(() => {
    const t = setTimeout(() => setDeb(q.trim()), 150);
    return () => clearTimeout(t);
  }, [q]);
  const hits = useQuery({ queryKey: ["globalSearch", deb], queryFn: () => api.globalSearch(deb), enabled: deb.length >= 2 }).data ?? [];
  const txns = useQuery({ queryKey: ["paletteTxns", deb], queryFn: () => api.listTransactions({ search: deb, limit: 6 }), enabled: deb.length >= 2 }).data?.items ?? [];
  const close = () => setPalette(false);

  const items = useMemo<Item[]>(() => {
    const n = norm(q.trim());
    const has = (...s: (string | null | undefined)[]) => !n || s.some((x) => x && norm(x).includes(n));
    const out: Item[] = [];
    const actions: Item[] = [
      { key: "a-exp", group: "Действия", title: "Новый расход", detail: "Ctrl+N", section: "transactions", run: () => openTxnForm({ mode: "new", type: "expense" }) },
      { key: "a-inc", group: "Действия", title: "Новый доход", section: "transactions", run: () => openTxnForm({ mode: "new", type: "income" }) },
      { key: "a-tr", group: "Действия", title: "Новый перевод", detail: "Ctrl+T", section: "transactions", run: () => openTxnForm({ mode: "new", type: "transfer" }) },
      { key: "a-subs", group: "Действия", title: "Подписки и регулярные платежи", section: "reports", run: () => openReport("subs") },
      { key: "a-year", group: "Действия", title: "Итоги года", section: "reports", run: () => openReport("year") },
    ];
    // Переключатели — только по запросу, чтобы пустой список оставался коротким.
    if (n) {
      const dark = savedTheme() === "dark";
      actions.push(
        { key: "a-hide", group: "Действия", title: hidden ? "Показать суммы" : "Скрыть суммы", detail: "Ctrl+H", words: "скрыть показать суммы деньги глаз", section: "settings", run: () => setSetting.run("hide_amounts", hidden ? "0" : "1") },
        { key: "a-theme", group: "Действия", title: dark ? "Светлая тема" : "Тёмная тема", words: "тема светлая тёмная тёмный оформление цвет", section: "settings", run: () => applyTheme(dark ? "light" : "dark") },
        { key: "a-keys", group: "Действия", title: "Горячие клавиши", detail: "F1", words: "клавиши сочетания справка", section: "settings", run: () => setHelp(true) },
      );
    }
    out.push(...actions.filter((a) => has(a.title, a.words)));
    SECTIONS.forEach((s, i) => sectionOn(s.id) && has(s.title, s.hint) && out.push({ key: `s-${s.id}`, group: "Разделы", title: s.title, detail: i < 9 ? `Ctrl+${i + 1}` : s.hint, section: s.id, run: () => go(s.id) }));
    if (n)
      SETTINGS.filter((x) => has(x.title, x.words)).forEach((x) =>
        out.push({ key: `set-${x.key}`, group: "Настройки", title: x.title, section: "settings", run: () => openSettings({ section: x.section, field: x.field, dialog: x.dialog }) }),
      );
    if (n) {
      accounts.filter((a) => has(a.name)).slice(0, 5).forEach((a) => out.push({ key: `acc-${a.id}`, group: "Счета", title: a.name, detail: `${formatAmount(a.balance, a.minorUnits)} ${a.currencySymbol}`, section: "accounts", run: () => showTransactions({ accountId: a.id }) }));
      categories.filter((c) => has(c.name)).slice(0, 5).forEach((c) => out.push({ key: `cat-${c.id}`, group: "Категории", title: c.name, detail: c.kind === "income" ? "доход" : "расход", section: "categories", run: () => showTransactions({ categoryId: c.id }) }));
      views.filter((v) => has(v.name)).slice(0, 5).forEach((v) => out.push({ key: `v-${v.id}`, group: "Сохранённые виды", title: v.name, section: v.kind === "report" ? "reports" : "transactions", run: () => openView(v) }));
      hits.forEach((h) => {
        const [group, section] = HIT_GROUP[h.kind];
        const run = h.kind === "debt" ? () => openDebt(h.id) : h.kind === "tag" ? () => showTransactions({ tagId: h.id }) : () => go(section);
        const detail = h.detail && /^\d{4}-\d{2}-\d{2}$/.test(h.detail) ? formatDate(h.detail) : (h.detail ?? undefined);
        out.push({ key: `h-${h.kind}-${h.id}`, group, title: h.title, detail, section, run });
      });
      txns.forEach((t) =>
        out.push({
          key: `t-${t.id}`,
          group: "Операции",
          title: t.payee || t.categoryName || t.note || "Операция",
          detail: `${formatDate(t.date)} · ${formatAmount(t.amount, t.minorUnits)} ${t.currencySymbol}`,
          section: "transactions",
          run: () => openTxnForm({ mode: "edit", txn: t }),
        }),
      );
      out.push({ key: "all", group: "Операции", title: `Все операции с «${q.trim()}»`, section: "transactions", run: () => showTransactions({ search: q.trim() }) });
    }
    return out;
  }, [q, accounts, categories, views, hits, txns, go, showTransactions, openTxnForm, openDebt, openView, openReport, openSettings, setHelp, hidden, setSetting, sectionOn]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.run();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return close();
    if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(items.length - 1, a + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === "Enter") (e.preventDefault(), pick(items[active]));
  };

  let lastGroup = "";
  return (
    <div className="palette" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette-box" role="dialog" aria-label="Поиск по всему" data-testid="palette">
        <input
          autoFocus
          name="paletteQuery"
          placeholder="Найти раздел, счёт, заметку, операцию…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[active] ? `pal-${items[active].key}` : undefined}
        />
        <ul className="palette-list" id="palette-list" role="listbox" ref={list}>
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <li key={it.key} role="presentation">
                {head && <div className="palette-group">{head}</div>}
                <div
                  id={`pal-${it.key}`}
                  role="option"
                  aria-selected={i === active}
                  className="palette-item"
                  data-testid="palette-item"
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => pick(it)}
                >
                  <SectionIcon id={it.section} />
                  <span className="p-title">{it.title}</span>
                  {it.detail && <span className="p-detail">{it.detail}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        {items.length === 0 && <div className="palette-empty">Ничего не нашлось</div>}
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> выбрать
          </span>
          <span>
            <kbd>Enter</kbd> открыть
          </span>
          <span>
            <kbd>Esc</kbd> закрыть
          </span>
        </div>
      </div>
    </div>
  );
}
