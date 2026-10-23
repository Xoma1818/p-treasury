// Полоса под списком операций (Г1, Г2): сумма выделенного или найденного
// и действия с пачкой. Всё действие — один шаг журнала, отмена одним Ctrl+Z.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type BulkResult, type Sums, type TxnFilter } from "../lib/api";
import { useAccounts, useCategories } from "../lib/queries";
import { plural } from "../lib/receipt";
import { useAction } from "../lib/useAction";
import { AccountSelect, CategorySelect } from "./Fields";
import { Hint } from "./Hint";
import { ErrorText } from "./Modal";
import { BaseMoney } from "./Money";

type Mode = "category" | "payee" | "account" | "tag" | "delete" | null;

/** Почему строки пропущены: зависит от действия. */
const SKIP_WHY: Record<Exclude<Mode, null>, string> = {
  category: "переводы, корректировки, платежи по долгам и операции другого вида (доход или расход) эту категорию не получают",
  payee: "платежи по долгам меняются в карточке долга",
  account: "платежи по долгам, корректировки, операции в другой валюте и переводы на этот же счёт остались как были",
  tag: "у них тег уже был или его не было",
  delete: "платежи по долгам удаляются в карточке долга",
};

const DONE: Record<Exclude<Mode, null>, string> = {
  category: "Категория поставлена",
  payee: "Получатель изменён",
  account: "Счёт изменён",
  tag: "Теги обновлены",
  delete: "Удалено",
};

export function resultText(mode: Exclude<Mode, null>, r: BulkResult) {
  const head = `${DONE[mode]}: ${r.changed} ${plural(r.changed, "операция", "операции", "операций")}`;
  if (!r.skipped) return `${head}. Отменить — Ctrl+Z.`;
  return `${head}, пропущено ${r.skipped}: ${SKIP_WHY[mode]}. Отменить — Ctrl+Z.`;
}

export function SelectionBar({ ids, filter, filtered, onClear, onDone }: {
  /** Выделенные операции; пусто — итог по найденному. */
  ids: string[];
  filter: TxnFilter;
  /** Включён фильтр или поиск: без выделения показываем итог найденного. */
  filtered: boolean;
  onClear: () => void;
  onDone: () => void;
}) {
  const selected = ids.length > 0;
  const key = selected ? [...ids].sort().join(",") : "";
  const sums = useQuery({
    queryKey: selected ? ["sumSelected", key] : ["sumFiltered", filter],
    queryFn: () => (selected ? api.sumSelected(ids) : api.sumFiltered(filter)),
    enabled: selected || filtered,
    placeholderData: keepPreviousData,
  }).data;
  const [mode, setMode] = useState<Mode>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), 10000);
    return () => window.clearTimeout(t);
  }, [message]);
  if (!selected && !filtered && !message) return null;

  return (
    <div className={selected ? "sel-bar active" : "sel-bar"} data-testid="sel-bar" role="region" aria-label={selected ? "Выбранные операции" : "Итог найденного"}>
      <div className="sel-sum">
        {(selected || filtered) && <SumLine s={sums} selected={selected} />}
        {!selected && <Hint of="txn.select" />}
      </div>
      {selected && (
        <div className="sel-actions">
          {mode === null && (
            <>
              <button className="btn small" onClick={() => (setMessage(null), setMode("category"))}>
                Категория
              </button>
              <button className="btn small" onClick={() => (setMessage(null), setMode("payee"))}>
                Получатель
              </button>
              <button className="btn small" onClick={() => (setMessage(null), setMode("account"))}>
                Счёт
              </button>
              <button className="btn small" onClick={() => (setMessage(null), setMode("tag"))}>
                Тег
              </button>
              <button className="btn small danger" onClick={() => (setMessage(null), setMode("delete"))} data-testid="bulk-delete">
                Удалить
              </button>
              <Hint of="txn.bulk" />
              <button className="link" onClick={onClear} title="Esc">
                Снять выделение
              </button>
            </>
          )}
          {mode && (
            <BulkForm
              mode={mode}
              ids={ids}
              onCancel={() => setMode(null)}
              onDone={(r) => {
                setMessage(resultText(mode, r));
                setMode(null);
                onDone();
              }}
            />
          )}
        </div>
      )}
      {message && (
        <div className="sel-message" data-testid="bulk-message" role="status">
          {message}
        </div>
      )}
    </div>
  );
}

function SumLine({ s, selected }: { s: Sums | undefined; selected: boolean }) {
  if (!s) return <span className="muted">{selected ? "Считаем выбранные…" : "Считаем найденное…"}</span>;
  return (
    <span data-testid="sel-sum">
      <b>
        {selected ? "Выбрано" : "Найдено"} {s.count}
      </b>
      : расходы <BaseMoney amount={s.expense} />, доходы <BaseMoney amount={s.income} />, итог{" "}
      <b className={s.total < 0 ? "minus" : s.total > 0 ? "plus" : undefined}>
        <BaseMoney amount={s.total} signed />
      </b>
      {s.missingRates.length > 0 && <span className="warn"> · нет курса {s.missingRates.join(", ")}: такие не вошли</span>}
    </span>
  );
}

function BulkForm({ mode, ids, onCancel, onDone }: { mode: Exclude<Mode, null>; ids: string[]; onCancel: () => void; onDone: (r: BulkResult) => void }) {
  const categories = useCategories().data ?? [];
  const accounts = useAccounts().data ?? [];
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.listTags, enabled: mode === "tag" }).data ?? [];
  const [value, setValue] = useState("");
  const n = ids.length;
  const word = plural(n, "операцию", "операции", "операций");
  const act = useAction(
    (run: () => Promise<BulkResult>) => run(),
    (r) => onDone(r),
  );
  const busy = act.busy;
  const cancel = (
    <button className="btn small" onClick={onCancel} disabled={busy}>
      Отмена
    </button>
  );

  let body: React.ReactNode;
  switch (mode) {
    case "category":
      body = (
        <>
          <CategorySelect name="bulkCategory" categories={categories} value={value} onChange={setValue} placeholder="Новая категория" />
          <button className="btn small primary" disabled={!value || busy} aria-busy={busy} onClick={() => act.run(() => api.bulkSetCategory(ids, value))}>
            Поставить
          </button>
        </>
      );
      break;
    case "payee":
      body = (
        <>
          <input
            name="bulkPayee"
            aria-label="Получатель"
            placeholder="Получатель (пусто — убрать)"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && act.run(() => api.bulkSetPayee(ids, value.trim() || null))}
          />
          <button className="btn small primary" disabled={busy} aria-busy={busy} onClick={() => act.run(() => api.bulkSetPayee(ids, value.trim() || null))}>
            {value.trim() ? "Поставить" : "Убрать получателя"}
          </button>
        </>
      );
      break;
    case "account":
      body = (
        <>
          <AccountSelect name="bulkAccount" accounts={accounts} value={value} onChange={setValue} placeholder="Новый счёт" />
          <button className="btn small primary" disabled={!value || busy} aria-busy={busy} onClick={() => act.run(() => api.bulkSetAccount(ids, value))}>
            Перенести
          </button>
        </>
      );
      break;
    case "tag":
      body = (
        <>
          <input
            name="bulkTag"
            aria-label="Тег"
            list="bulk-tags"
            placeholder="Тег, например «ремонт»"
            value={value}
            autoFocus
            autoComplete="off"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && value.trim() && act.run(() => api.bulkTag(ids, value.trim(), true))}
          />
          <datalist id="bulk-tags">
            {tags.map((t) => (
              <option key={t.id} value={t.name} />
            ))}
          </datalist>
          <button className="btn small primary" disabled={!value.trim() || busy} onClick={() => act.run(() => api.bulkTag(ids, value.trim(), true))}>
            Добавить
          </button>
          <button className="btn small" disabled={!value.trim() || busy} onClick={() => act.run(() => api.bulkTag(ids, value.trim(), false))}>
            Снять
          </button>
        </>
      );
      break;
    case "delete":
      body = (
        <>
          <span className="sel-confirm">
            Удалить {n} {word}? Отменить можно через Ctrl+Z.
          </span>
          <button className="btn small danger" autoFocus disabled={busy} aria-busy={busy} data-testid="bulk-delete-confirm" onClick={() => act.run(() => api.bulkDelete(ids))}>
            Да, удалить
          </button>
        </>
      );
      break;
  }
  return (
    <div className="sel-form" data-testid={`bulk-${mode}`} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onCancel())}>
      {mode !== "delete" && (
        <span className="muted">
          {n} {word}:
        </span>
      )}
      {body}
      {cancel}
      <ErrorText error={act.error} />
    </div>
  );
}
