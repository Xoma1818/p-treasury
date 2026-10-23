// Карточки Главной 0.16: «Необычно в этом месяце» (А2) и «Проверьте» (А3).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Check } from "../lib/api";
import { formatDate, today } from "../lib/dates";
import { useMonthOf, useSettings } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { Hint } from "./Hint";
import { ErrorText } from "./Modal";
import { Money } from "./Money";
import { Sparkline } from "./Dashboard";

/** А2: до трёх категорий, где траты с начала месяца заметно не как обычно. */
export function UnusualCard() {
  const month = useMonthOf(today()).data?.month;
  const r = useQuery({ queryKey: ["usual", month], queryFn: () => api.spendingVsUsual(month!), enabled: !!month }).data;
  const showTransactions = useUi((s) => s.showTransactions);
  return (
    <div className="card qw-card" data-testid="home-unusual">
      <h2>
        Необычно в этом месяце
        <Hint of="home.unusual" />
      </h2>
      {r && r.monthsCounted === 0 && <p className="muted">Сравнивать пока не с чем: нужна история хотя бы за один прошлый месяц.</p>}
      {r && r.monthsCounted > 0 && r.home.length === 0 && <p className="muted qw-calm">Траты идут как обычно.</p>}
      {r && r.home.length > 0 && (
        <ul className="qw-list">
          {r.home.map((u) => {
            const up = (u.percent ?? 0) > 0;
            return (
              <li key={u.categoryId}>
                <button
                  className="qw-row clickable"
                  data-testid="unusual-row"
                  title="Показать операции категории за месяц"
                  onClick={() => showTransactions({ categoryId: u.categoryId, dateFrom: r.from, dateTo: r.to })}
                >
                  <span className="qw-main">
                    <b>{u.name}</b>: <Money amount={u.current} symbol={r.baseSymbol} />
                  </span>
                  <span className={up ? "usual-pill up" : "usual-pill down"}>
                    {u.percent == null ? "раньше не было" : `на ${Math.abs(u.percent)} % ${up ? "больше" : "меньше"} обычного`}
                  </span>
                  <span className="qw-sub muted">
                    обычно <Money amount={u.usual} symbol={r.baseSymbol} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {r && r.monthsCounted > 0 && r.monthsCounted < 3 && <p className="hint">Сравнение по {r.monthsCounted === 1 ? "одному прошлому месяцу" : "двум прошлым месяцам"}.</p>}
    </div>
  );
}

const KIND: Record<Check["kind"], string> = {
  duplicate: "Дубль?",
  large: "Крупнее обычного",
  price: "Подорожало",
};

/** Прячет суммы в готовом тексте ядра, когда включено «Скрыть суммы». */
export function maskAmounts(text: string): string {
  return text.replace(/[−+-]?\d[\d\s\u00a0\u202f]*(?:[.,]\d+)?\s?(?:₽|\$|€|¥|£|₸)/g, "•••");
}

/** Сколько строк «Проверьте» видно сразу; остальные — по «Показать все». */
const CHECKS_SHOWN = 5;

/** А3: странные списания за 30 дней. */
export function ChecksCard() {
  const hidden = useSettings().data?.hide_amounts === "1";
  const show = (t: string) => (hidden ? maskAmounts(t) : t);
  const checks = useQuery({ queryKey: ["checks"], queryFn: api.listChecks }).data;
  const openTxnForm = useUi((s) => s.openTxnForm);
  const dismiss = useAction(api.dismissCheck);
  const removeSecond = useAction(api.deleteDuplicate);
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = checks && !showAll ? checks.slice(0, CHECKS_SHOWN) : checks;

  // Операцию находим среди операций её дня: отдельной команды «одна операция» нет.
  const open = async (c: Check) => {
    setOpening(c.key);
    setOpenError(null);
    try {
      const page = await api.listTransactions({ dateFrom: c.date, dateTo: c.date, limit: 1000 });
      const t = page.items.find((x) => x.id === c.transactionId);
      if (t) openTxnForm({ mode: "edit", txn: t });
      else setOpenError("Операция не найдена: возможно, её уже удалили.");
    } catch (e) {
      setOpenError(String(e));
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="card qw-card" data-testid="home-checks">
      <h2>
        Проверьте
        <Hint of="home.checks" />
      </h2>
      {checks && checks.length === 0 && (
        <p className="qw-calm" data-testid="checks-calm">
          <span className="qw-ok" aria-hidden>
            ✓
          </span>
          Всё спокойно: странных списаний за 30 дней нет.
        </p>
      )}
      {checks && checks.length > 0 && (
        <ul className="qw-list">
          {shown!.map((c) => (
            <li key={c.key} className="qw-check" data-testid="check-row" data-kind={c.kind}>
              <span className={`qw-kind ${c.kind}`}>{KIND[c.kind]}</span>
              <span className="qw-text">
                <span className="qw-main">{show(c.title)}</span>
                <span className="qw-sub muted">
                  {show(c.detail)} · {formatDate(c.date)}
                </span>
              </span>
              <span className="qw-actions">
                <button className="btn small" onClick={() => open(c)} disabled={opening === c.key} aria-busy={opening === c.key}>
                  Открыть
                </button>
                {c.kind === "duplicate" && c.secondId && (
                  <button
                    className="btn small danger"
                    title="Удалить более позднюю из двух операций. Отмена — Ctrl+Z"
                    onClick={() => removeSecond.run(c.secondId!)}
                    disabled={removeSecond.busy}
                  >
                    Удалить второй
                  </button>
                )}
                <button className="btn small" onClick={() => dismiss.run(c.key)} disabled={dismiss.busy} data-testid="check-ok">
                  Всё в порядке
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {checks && checks.length > CHECKS_SHOWN && (
        <button type="button" className="link qw-more" data-testid="checks-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Свернуть" : `Показать все (${checks.length})`}
        </button>
      )}
      <ErrorText error={dismiss.error ?? removeSecond.error ?? openError} />
    </div>
  );
}

/** В3: мини-график чистых активов за 12 месяцев у плитки баланса; нажатие открывает отчёт. */
export function NetWorthSpark() {
  const h = useQuery({ queryKey: ["netWorth", 12], queryFn: () => api.netWorthHistory(12) }).data;
  const openReport = useUi((s) => s.openReport);
  const values = h?.points.map((p) => p.net) ?? [];
  if (values.length < 2) return null;
  return (
    <button className="nw-spark" data-testid="home-net-worth-spark" title="Чистые активы за 12 месяцев — открыть отчёт" onClick={() => openReport("networth")}>
      <Sparkline values={values} className="networth" />
    </button>
  );
}
