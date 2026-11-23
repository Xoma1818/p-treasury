import { useQuery } from "@tanstack/react-query";
import { api, SUB_PERIODS, type Subscription } from "../lib/api";
import { addDays, formatDate, today } from "../lib/dates";
import { type TxnJump, useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { plural } from "./Dashboard";
import { Hint } from "./Hint";
import { ErrorText } from "./Modal";
import { BaseMoney, Money } from "./Money";

const useSubscriptions = () => useQuery({ queryKey: ["subscriptions"], queryFn: api.listSubscriptions });

const HINT = (
  <Hint title="Подписки и регулярные платежи" example="Яндекс Плюс 299 ₽ каждый месяц">
    Приложение само находит расходы, которые повторяются у одного получателя с ровным шагом и почти той же суммой. Если это не подписка, скройте её.
  </Hint>
);

/** «следующий 05.11» или заметная плашка, если спишется сегодня или завтра. */
function Next({ date }: { date: string }) {
  const now = today();
  if (date === now || date === addDays(now, 1))
    return (
      <span className="sub-soon" data-testid="sub-soon">
        спишется {date === now ? "сегодня" : "завтра"}
      </span>
    );
  return <>следующий {formatDate(date)}</>;
}

const seriesId = (s: Subscription) => `sub-${s.currencyCode}-${s.key}`;
type OpenPayments = (filter: TxnJump, source: string) => void;

function Row({ s, openOperations, onHide, busy }: { s: Subscription; openOperations?: OpenPayments; onHide?: (s: Subscription) => void; busy?: boolean }) {
  const showTransactions = useUi((u) => u.showTransactions);
  const openPayments = () => {
    const filter = { subscription: { key: s.key, currencyCode: s.currencyCode } };
    if (openOperations) openOperations(filter, seriesId(s));
    else showTransactions(filter);
  };
  return (
    <li className={s.hidden ? "hidden-sub" : undefined} data-testid="sub-row" data-key={s.key} data-currency={s.currencyCode}>
      <span className="sub-badge" aria-hidden="true">
        {s.payee.slice(0, 1).toUpperCase()}
      </span>
      <span className="sub-name">
        <button type="button" className="link main" onClick={openPayments} data-report-source={seriesId(s)} aria-label={`Показать платежи: ${s.payee}, ${s.currencyCode}`} title="Показать платежи">
          {s.payee}
        </button>
        <span>
          {s.categoryName ? `${s.categoryName} · ` : ""}{s.currencyCode} ·{" "}
          <Next date={s.nextDate} />
        </span>
      </span>
      <span className="sub-sum">
        <Money amount={s.amount} symbol={s.currencySymbol} currencyCode={s.currencyCode} minorUnits={s.minorUnits} />
        <span>
          {SUB_PERIODS[s.period]}
          {s.yearly != null && s.period !== "year" && (
            <>
              {" · "}
              <BaseMoney amount={s.yearly} /> в год
            </>
          )}
        </span>
      </span>
      {onHide && (
        <button className="link" onClick={() => onHide(s)} disabled={busy} data-testid="sub-hide">
          {s.hidden ? "Вернуть" : "Не подписка"}
        </button>
      )}
    </li>
  );
}

/** Карточка на Главной: сколько уходит на подписки и самые дорогие. */
export function SubscriptionsCard() {
  const data = useSubscriptions().data;
  const openReport = useUi((u) => u.openReport);
  const visible = data?.items.filter((s) => !s.hidden) ?? [];
  // Что спишется сегодня или завтра — первым, остальное по стоимости в год.
  const soon = addDays(today(), 1);
  const first = [...visible.filter((s) => s.nextDate <= soon), ...visible.filter((s) => s.nextDate > soon)];
  return (
    <div className="card" data-testid="home-subs">
      <div className="screen-head">
        <h2>
          Регулярные платежи
          {HINT}
        </h2>
        <button className="link" onClick={() => openReport("subs")}>
          Все подписки
        </button>
      </div>
      {visible.length === 0 ? (
        <p className="muted">Регулярных платежей пока не видно. Они появятся, когда одна и та же трата повторится хотя бы три раза.</p>
      ) : (
        <>
          <div className="subs-total">
            <span>
              <b data-testid="subs-month">
                <BaseMoney amount={data!.monthlyTotal} />
              </b>{" "}
              <span className="muted">в месяц</span>
            </span>
            <span className="muted">
              <BaseMoney amount={data!.yearlyTotal} /> в год · {visible.length} {plural(visible.length, "платёж", "платежа", "платежей")}
            </span>
          </div>
          <ul className="subs-list">
            {first.slice(0, 4).map((s) => (
              <Row key={seriesId(s)} s={s} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Вкладка «Подписки» в Отчётах: полный список, можно скрыть лишнее. */
export function SubscriptionsReport({ openOperations, showHidden, setShowHidden }: {
  openOperations: OpenPayments; showHidden: boolean; setShowHidden: (value: boolean) => void;
}) {
  const data = useSubscriptions().data;
  const hide = useAction((s: Subscription) => api.hideSubscription(s.key, s.currencyCode, !s.hidden));
  if (!data) return null;
  const hiddenCount = data.items.filter((s) => s.hidden).length;
  const items = data.items.filter((s) => showHidden || !s.hidden);
  return (
    <div className="card" data-testid="subs">
      <div className="screen-head">
        <h2>
          Подписки и регулярные платежи
          {HINT}
        </h2>
        {hiddenCount > 0 && (
          <label className="check">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Показать скрытые ({hiddenCount})
          </label>
        )}
      </div>
      <div className="subs-total">
        <span>
          <b data-testid="subs-year">
            <BaseMoney amount={data.yearlyTotal} />
          </b>{" "}
          <span className="muted">в год</span>
        </span>
        <span className="muted">
          ≈ <BaseMoney amount={data.monthlyTotal} /> в месяц
        </span>
      </div>
      {items.length === 0 ? (
        <p className="muted">Регулярных платежей не найдено. Нужно хотя бы три платежа одному получателю с ровным шагом (для годовых — два).</p>
      ) : (
        <ul className="subs-list">
          {items.map((s) => (
            <Row key={seriesId(s)} s={s} openOperations={openOperations} onHide={hide.run} busy={hide.busy} />
          ))}
        </ul>
      )}
      <ErrorText error={hide.error} />
    </div>
  );
}
