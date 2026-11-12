// Р1, Р14 (этап 8г): «Своя цифра» — карточка Главной с одной суммой за выбранный период
// с отбором по категории, счёту и тегу. Список хранится в настройке `home_figures`,
// значения считает ядро тем же расчётом, что отчёты.
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { api, type Figure, type FigureMeasure, type FigurePeriod, type FigureValue, type HomeRange, type TxnType } from "../lib/api";
import { formatDate, today } from "../lib/dates";
import { useFine } from "../lib/fine";
import { parseLayout, toSetting } from "../lib/homeLayout";
import { useAccounts, useCategories, useSettings } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { AccountSelect, CategorySelect, Field } from "./Fields";
import { change, Delta } from "./Dashboard";
import { Hint } from "./Hint";
import { ErrorText, Modal } from "./Modal";
import { BaseMoney } from "./Money";

export const MEASURE_LABEL: Record<FigureMeasure, string> = {
  expense: "Расходы",
  income: "Доходы",
  saldo: "Сальдо (доходы − расходы)",
  balance: "Остаток на счетах",
};

export const PERIOD_LABEL: Record<FigurePeriod, string> = {
  month: "Этот месяц",
  week: "Эта неделя",
  payday: "От зарплаты до зарплаты",
  quarter: "Этот квартал",
  year: "Этот год",
  days30: "Последние 30 дней",
  custom: "Свои даты",
};

/** Подпись периода под цифрой: «с 05.11 (зарплата)», «09.11 – 15.11». */
export function rangeText(r: HomeRange): string {
  if (r.kind === "payday") return r.payday ? `с зарплаты ${formatDate(r.payday)}${r.nextIncome ? ` до ${formatDate(r.nextIncome)}` : ""}` : "зарплаты не нашли — месяц";
  return `${formatDate(r.from)} – ${formatDate(r.to)}`;
}

export const parseFigures = (raw: string | undefined): Figure[] => {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export function useFigureValues() {
  const week = useFine().week;
  const date = today();
  return useQuery({ queryKey: ["figureValues", date, week], queryFn: () => api.figureValues(date, week === "sun") });
}

/** Карточка «Свои цифры» на Главной. */
export function FiguresCard() {
  const figures = parseFigures(useSettings().data?.home_figures);
  const values = useFigureValues().data ?? [];
  const [editing, setEditing] = useState<Figure | "new" | null>(null);
  const showTransactions = useUi((s) => s.showTransactions);
  const valueOf = (id: string) => values.find((v) => v.id === id);
  const open = (f: Figure, v: FigureValue) => {
    if (f.measure === "balance") return showTransactions({ accountId: f.accountId ?? undefined });
    const types: TxnType[] = f.measure === "expense" ? ["expense"] : f.measure === "income" ? ["income"] : ["income", "expense"];
    showTransactions({ types, dateFrom: v.range.from, dateTo: v.range.to, accountId: f.accountId ?? undefined, categoryId: f.categoryId ?? undefined, tagId: f.tagId ?? undefined });
  };
  return (
    <div className="card" data-testid="home-figures">
      <div className="notes-head">
        <h2>
          Свои цифры
          <Hint of="home.figures" />
        </h2>
        <button className="btn small" onClick={() => setEditing("new")} data-testid="figure-add">
          + Своя цифра
        </button>
      </div>
      {figures.length === 0 && <p className="muted">Любая сумма на виду: «Кафе за неделю», «Траты с карты с зарплаты», «Остаток на вкладе». Ещё цифру можно отправить сюда из любого отчёта кнопкой «На Главную».</p>}
      <div className="figure-tiles">
        {figures.map((f) => {
          const v = valueOf(f.id);
          return (
            <div key={f.id} className="figure-tile" data-testid="figure" data-name={f.title}>
              <div className="tile-label">
                <span>{f.title}</span>
                {v && f.measure !== "balance" && <Delta pct={change(v.value, v.prev ?? undefined)} lowerIsBetter={f.measure === "expense"} hint="к тем же дням прошлого периода" />}
                <button className="icon-btn figure-edit" aria-label={`Изменить «${f.title}»`} onClick={() => setEditing(f)}>
                  <Pencil size={14} aria-hidden />
                </button>
              </div>
              <button type="button" className="tile-value tile-explain" title="Показать операции" data-testid="figure-value" onClick={() => v && open(f, v)}>
                {v ? <BaseMoney amount={v.value} signed={f.measure === "saldo"} /> : "…"}
              </button>
              {v && <div className="sub muted small">{f.measure === "balance" ? `на ${formatDate(today() < v.range.to ? today() : v.range.to)}` : rangeText(v.range)}</div>}
              {v && v.missingRates.length > 0 && <div className="hint warn">Нет курса для {v.missingRates.join(", ")}</div>}
            </div>
          );
        })}
      </div>
      {editing && <FigureForm figure={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Окно цифры: новая (по образцу `draft`, например из отчёта) или изменение. */
export function FigureForm({ figure, draft, note, onClose, onSaved }: { figure: Figure | null; draft?: Partial<Figure>; note?: string; onClose: () => void; onSaved?: () => void }) {
  const settings = useSettings().data;
  const all = parseFigures(settings?.home_figures);
  const start = figure ?? draft ?? {};
  const [title, setTitle] = useState(start.title ?? "");
  const [measure, setMeasure] = useState<FigureMeasure>(start.measure ?? "expense");
  const [period, setPeriod] = useState<FigurePeriod>(start.period ?? "month");
  const [categoryId, setCategoryId] = useState(start.categoryId ?? "");
  const [accountId, setAccountId] = useState(start.accountId ?? "");
  const [tagId, setTagId] = useState(start.tagId ?? "");
  const [from, setFrom] = useState(start.from ?? "");
  const [to, setTo] = useState(start.to ?? "");
  const categories = useCategories().data ?? [];
  const accounts = useAccounts().data ?? [];
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags }).data ?? [];
  const balance = measure === "balance";
  const kind = measure === "income" ? "income" : measure === "expense" ? "expense" : undefined;
  const save = useAction(
    async (list: Figure[]) => {
      await api.saveFigures(list);
      // Цифра должна быть видна: карточка «Свои цифры» показывается на Главной.
      const layout = parseLayout(settings?.home_layout);
      if (layout.hidden.includes("figures")) await api.setSetting("home_layout", toSetting({ ...layout, hidden: layout.hidden.filter((b) => b !== "figures") }));
    },
    () => {
      onSaved?.();
      onClose();
    },
  );
  const submit = () => {
    const f: Figure = {
      id: figure?.id ?? `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: title.trim() || autoTitle(),
      measure,
      period,
      categoryId: balance ? null : categoryId || null,
      accountId: accountId || null,
      tagId: balance ? null : tagId || null,
      ...(period === "custom" && !balance ? { from: from || null, to: to || null } : {}),
    };
    save.run(figure ? all.map((x) => (x.id === f.id ? f : x)) : [...all, f]);
  };
  const autoTitle = () => {
    const cat = categories.find((c) => c.id === categoryId)?.name;
    const acc = accounts.find((a) => a.id === accountId)?.name;
    const base = balance ? (acc ?? "Остаток") : (cat ?? MEASURE_LABEL[measure].split(" ")[0]);
    if (balance) return base;
    if (period === "custom") return from && to ? `${base}, ${formatDate(from)} – ${formatDate(to)}` : base;
    return `${base}, ${PERIOD_LABEL[period].toLowerCase().replace(/^этот |^эта /, "")}`;
  };
  const move = (delta: number) => {
    if (!figure) return;
    const i = all.findIndex((x) => x.id === figure.id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= all.length) return;
    const next = [...all];
    [next[i], next[j]] = [next[j], next[i]];
    save.run(next);
  };
  return (
    <Modal title={figure ? `Цифра «${figure.title}»` : "Своя цифра"} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())} data-testid="figure-form">
        {note && (
          <p className="hint warn" data-testid="figure-note">
            {note}
          </p>
        )}
        <Field label="Название" hint="Можно оставить пустым — подпишем сами.">
          {(id) => <input id={id} name="figureTitle" placeholder={autoTitle()} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} autoFocus />}
        </Field>
        <div className="row">
          <Field label="Что считать">
            {(id) => (
              <select id={id} name="figureMeasure" value={measure} onChange={(e) => setMeasure(e.target.value as FigureMeasure)}>
                {(Object.keys(MEASURE_LABEL) as FigureMeasure[]).map((m) => (
                  <option key={m} value={m}>
                    {MEASURE_LABEL[m]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={balance ? "На какой день" : "За какой период"} hint={balance ? "Остаток на сегодня; сравнение не показывается." : undefined}>
            {(id) => (
              <select id={id} name="figurePeriod" value={period} onChange={(e) => setPeriod(e.target.value as FigurePeriod)} disabled={balance}>
                {(Object.keys(PERIOD_LABEL) as FigurePeriod[]).map((p) => (
                  <option key={p} value={p}>
                    {PERIOD_LABEL[p]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        {!balance && period === "custom" && (
          <div className="row">
            <Field label="С даты">{(id) => <input id={id} type="date" name="figureFrom" value={from} onChange={(e) => setFrom(e.target.value)} required />}</Field>
            <Field label="По дату">{(id) => <input id={id} type="date" name="figureTo" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} required />}</Field>
          </div>
        )}
        {!balance && (
          <Field label="Категория" hint="Вместе с подкатегориями.">
            {(id) => <CategorySelect id={id} name="figureCategory" categories={categories} kind={kind} value={categoryId} onChange={setCategoryId} placeholder="Все категории" />}
          </Field>
        )}
        <div className="row">
          <Field label="Счёт">{(id) => <AccountSelect id={id} name="figureAccount" accounts={accounts} value={accountId} onChange={setAccountId} placeholder={balance ? "Все счета общего баланса" : "Все счета"} />}</Field>
          {!balance && (
            <Field label="Тег">
              {(id) => (
                <select id={id} name="figureTag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
                  <option value="">Без отбора</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
        </div>
        <ErrorText error={save.error} />
        <div className="actions">
          {figure && (
            <>
              <button type="button" className="link danger" onClick={() => save.run(all.filter((x) => x.id !== figure.id))}>
                Убрать с Главной
              </button>
              <button type="button" className="link" onClick={() => move(-1)} aria-label="Левее">
                ←
              </button>
              <button type="button" className="link" onClick={() => move(1)} aria-label="Правее">
                →
              </button>
            </>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} disabled={save.busy}>
            {figure ? "Сохранить" : "На Главную"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
