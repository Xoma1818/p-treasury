import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api, type YearReview } from "../lib/api";
import { formatDate, monthTitle } from "../lib/dates";
import { baseName, pickSave, PNG } from "../lib/files";
import { useCurrencies, useSettings } from "../lib/queries";
import { cardPng, drawYearCard } from "../lib/yearCard";
import { amountPrivacy, guardActive } from "../lib/amountPrivacy";
import { change, Delta, plural, Ring } from "./Dashboard";
import { Hint } from "./Hint";
import { ErrorText, Modal } from "./Modal";
import { BaseMoney } from "./Money";
import { MonthsChart } from "../screens/Reports";

/** «Итоги года»: главное о годе в нескольких карточках. */
export function YearReviewReport() {
  const now = new Date().getFullYear();
  const [year, setYear] = useState(now);
  const [sharing, setSharing] = useState(false);
  const q = useQuery({ queryKey: ["yearReview", year], queryFn: () => api.yearReview(year) });
  const r = q.data;
  const saved = r ? r.income - r.expense : 0;
  // Средние — по месяцам, где были операции (год мог начаться с середины).
  const active = Math.max(1, r?.months.filter((m) => m.income !== 0 || m.expense !== 0).length ?? 1);
  return (
    <div className="card" data-testid="year-review">
      <div className="screen-head">
        <div className="year-head">
          <button className="icon-btn" aria-label="Прошлый год" onClick={() => setYear(year - 1)}>
            <ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <h2 data-testid="year-title">Итоги {year} года</h2>
          <button className="icon-btn" aria-label="Следующий год" onClick={() => setYear(year + 1)} disabled={year >= now}>
            <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <Hint title="Итоги года" example="«Лучший месяц — май: осталось 42 000 ₽»">
            Год в нескольких цифрах: сколько заработали, потратили и отложили, лучший и самый дорогой месяц, крупнейшая покупка и любимый магазин. Текущий год считается по сегодня и сравнивается с тем же отрезком прошлого.
          </Hint>
        </div>
        {r && r.transactionCount > 0 && (
          <button className="btn" onClick={() => setSharing(true)} data-testid="year-share">
            Картинка для друзей
          </button>
        )}
      </div>
      {sharing && r && <ShareDialog r={r} onClose={() => setSharing(false)} />}
      {q.error && <p className="error">{String(q.error)}</p>}
      {r && r.transactionCount === 0 && <p className="muted">За {year} год операций нет.</p>}
      {r && r.transactionCount > 0 && (
        <>
          <div className="year-hero">
            <div className="card tile">
              <div className="tile-label">
                Заработали
                <Delta pct={r.prevIncome ? change(r.income, r.prevIncome) : null} hint="к тому же времени прошлого года" />
              </div>
              <span className="year-big" data-testid="year-income">
                <BaseMoney amount={r.income} />
              </span>
              <div className="hint">
                в среднем <BaseMoney amount={Math.round(r.income / active)} /> в месяц
              </div>
            </div>
            <div className="card tile">
              <div className="tile-label">
                Потратили
                <Delta pct={r.prevExpense ? change(r.expense, r.prevExpense) : null} hint="к тому же времени прошлого года" lowerIsBetter />
              </div>
              <span className="year-big" data-testid="year-expense">
                <BaseMoney amount={r.expense} />
              </span>
              <div className="hint">
                в среднем <BaseMoney amount={Math.round(r.expense / active)} /> в месяц, <BaseMoney amount={Math.round(r.expense / r.days)} /> в день
              </div>
            </div>
            <div className="card tile summary-ring">
              <Ring percent={Math.max(0, r.savingsRate ?? 0)} size={104} label={`Отложено ${r.savingsRate ?? 0} % доходов`}>
                <b>{r.savingsRate ?? 0} %</b>
                <span>отложено</span>
              </Ring>
              <span className="muted">
                <BaseMoney amount={saved} signed />
              </span>
            </div>
          </div>
          {r.months.length > 1 && <MonthsChart r={{ months: r.months, income: r.income, expense: r.expense, balance: saved, savingsRate: r.savingsRate, missingRates: r.missingRates, baseCurrency: r.baseCurrency }} />}
          <div className="year-facts">
            {r.bestMonth && (
              <Fact eyebrow="Лучший месяц" title={monthTitle(r.bestMonth)}>
                осталось <BaseMoney amount={r.months.find((m) => m.period.month === r.bestMonth)?.balance ?? 0} />
              </Fact>
            )}
            {r.costliestMonth && (
              <Fact eyebrow="Самый дорогой месяц" title={monthTitle(r.costliestMonth)}>
                потрачено <BaseMoney amount={r.months.find((m) => m.period.month === r.costliestMonth)?.expense ?? 0} />
              </Fact>
            )}
            {r.topCategories[0] && (
              <Fact eyebrow="Больше всего ушло на" title={r.topCategories[0].name}>
                <BaseMoney amount={r.topCategories[0].amount} /> · {r.topCategories[0].percent} % расходов
                {r.topCategories.length > 1 && <> · затем {r.topCategories.slice(1, 3).map((c) => c.name).join(", ")}</>}
              </Fact>
            )}
            {r.biggestPurchase && (
              <Fact eyebrow="Самая крупная покупка" title={r.biggestPurchase.payee ?? r.biggestPurchase.categoryName ?? "Без названия"}>
                <BaseMoney amount={r.biggestPurchase.amount} /> · {formatDate(r.biggestPurchase.date)}
              </Fact>
            )}
            {r.topPayee && (
              <Fact eyebrow="Чаще всего платили" title={r.topPayee.name}>
                {r.topPayee.count} {plural(r.topPayee.count, "раз", "раза", "раз")} · <BaseMoney amount={r.topPayee.amount} />
              </Fact>
            )}
            <Fact eyebrow="Дни без трат" title={`${r.noSpendDays} ${plural(r.noSpendDays, "день", "дня", "дней")}`}>
              из {r.days} {plural(r.days, "дня", "дней", "дней")} учёта · {r.days ? Math.round((r.noSpendDays / r.days) * 100) : 0} %
            </Fact>
          </div>
          {r.missingRates.length > 0 && <p className="hint warn">Нет курса для {r.missingRates.join(", ")}: такие операции не вошли.</p>}
        </>
      )}
    </div>
  );
}

/** Картинка года: предпросмотр, «Без сумм», сохранить PNG или скопировать. */
function ShareDialog({ r, onClose }: { r: YearReview; onClose: () => void }) {
  const settings = useSettings().data;
  const base = useCurrencies().data?.find((c) => c.code === (settings?.base_currency ?? "RUB"));
  const [hideOnCard, setHideOnCard] = useState(false);
  const privacyLocked = !settings || settings.hide_amounts === "1";
  const hide = privacyLocked || hideOnCard;
  const [pending, setPending] = useState<"save" | "copy" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef({ revision: 0, masked: true });
  const sharing = useRef(false);
  useLayoutEffect(() => {
    const preview = canvas.current;
    if (!preview) return;
    const draw = () => {
      drawYearCard(preview, r, { symbol: base?.symbol ?? "₽", minorUnits: base?.minorUnits ?? 2, hideAmounts: hide });
      drawing.current = { revision: drawing.current.revision + 1, masked: hide };
    };
    draw();
    // В открытом предпросмотре может измениться системная тема или оформление другого окна.
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "data-accent"] });
    return () => observer.disconnect();
  }, [r, base, hide]);

  const share = async (action: "save" | "copy") => {
    const preview = canvas.current;
    if (!preview || sharing.current) return;
    sharing.current = true;
    const checkDrawing = (revision: number) => {
      const frame = drawing.current;
      if (canvas.current !== preview || revision !== frame.revision ||
          (!frame.masked && (amountPrivacy.state.getState().masked || guardActive()))) {
        throw new Error("Вид картинки изменился. Повторите действие.");
      }
    };
    setPending(action);
    setStatus(null);
    setError(null);
    try {
      if (action === "save") {
        const path = await pickSave(`Kazna — итоги ${r.year} года.png`, [PNG]);
        if (!path) return;
        const revision = drawing.current.revision;
        checkDrawing(revision);
        const bytes = new Uint8Array(await (await cardPng(preview)).arrayBuffer());
        checkDrawing(revision);
        await api.saveBytes(path, bytes);
        setStatus(`Сохранено: ${baseName(path)}`);
      } else {
        // Clipboard.write нужен жест пользователя, поэтому передаём PNG как Promise сразу.
        const revision = drawing.current.revision;
        checkDrawing(revision);
        const image = cardPng(preview).then(blob => { checkDrawing(revision); return blob; });
        await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
        setStatus("Картинка скопирована: вставьте её в чат через Ctrl+V");
      }
    } catch (e) {
      setError(action === "save" ? `Не удалось сохранить PNG: ${e}` : "Не получилось скопировать в буфер обмена: сохраните картинку файлом");
    } finally {
      sharing.current = false;
      setPending(null);
    }
  };
  return (
    <Modal title={`Итоги ${r.year} года — картинка`} onClose={onClose} wide>
      <div className="share-year">
        <canvas ref={canvas} className="share-canvas" data-testid="year-card" aria-label={`Картинка «Мой ${r.year} год»`} />
        <div className="share-side">
          <p className="muted">Картинку можно отправить в мессенджер или выложить. Цифры берутся из ваших данных, ничего не уходит в интернет.</p>
          <label className="check">
            <input
              type="checkbox"
              name="shareHide"
              checked={hide}
              disabled={pending !== null}
              aria-disabled={privacyLocked || undefined}
              aria-describedby={privacyLocked ? "share-privacy-hint" : undefined}
              onChange={(e) => {
                if (privacyLocked) return;
                setHideOnCard(e.target.checked);
                setStatus(null);
                setError(null);
              }}
            />
            Без сумм: только проценты и доли
          </label>
          {privacyLocked && <p id="share-privacy-hint" className="hint">{settings ? "Суммы скрыты во всём приложении, в том числе на картинке." : "Проверяем настройки видимости сумм."}</p>}
          <div className="btn-group">
            <button className="btn primary" disabled={pending !== null} onClick={() => void share("save")}>
              Сохранить PNG
            </button>
            <button className="btn" disabled={pending !== null} onClick={() => void share("copy")}>
              Копировать
            </button>
          </div>
          <p className={status ? "ok" : "muted"} role="status" data-testid="share-status" hidden={!status && !pending}>
            {status ?? (pending === "save" ? "Сохраняем PNG…" : pending === "copy" ? "Копируем картинку…" : "")}
          </p>
          <ErrorText error={error} />
        </div>
      </div>
    </Modal>
  );
}

function Fact({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <div className="year-fact fade-up" data-testid="year-fact">
      <span className="eyebrow">{eyebrow}</span>
      <b>{title}</b>
      <span>{children}</span>
    </div>
  );
}
