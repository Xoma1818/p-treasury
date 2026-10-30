// Экран «Взгляд вперёд» (0.18): прогноз остатка на 12 месяцев со сценариями
// «что если» и поток денег за месяц или год. Всё считает ядро (forecast.rs).
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { AmountInput, Field } from "../components/Fields";
import { Hint } from "../components/Hint";
import { ErrorText, Modal } from "../components/Modal";
import { BaseMoney as M } from "../components/Money";
import { ScreenTitle } from "../components/SectionIcon";
import { api, type ChangeInput, type ChangeKind, type Forecast as ForecastData, type ForecastItem, type ForecastMonth, type MoneyFlow, type Scenario } from "../lib/api";
import { formatDate, monthTitle, shiftMonth, today } from "../lib/dates";
import { CHANGE_KINDS, chartPoints, describeChange, flowIsEmpty, flowLayout, genitive, monthsText, prepositional, presets, ribbon } from "../lib/forecast";
import { amountToInput, parseAmount } from "../lib/money";
import { axisLabel, axisPad, netWorthScale } from "../lib/netWorth";
import { useMonthOf, useSettings } from "../lib/queries";
import { useAction } from "../lib/useAction";

type Tab = "forecast" | "flow";

export function Forecast() {
  const [tab, setTab] = useState<Tab>("forecast");
  return (
    <section className="screen forecast-screen">
      <ScreenTitle id="forecast" />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "forecast"} className={tab === "forecast" ? "tab active" : "tab"} onClick={() => setTab("forecast")} data-testid="tab-forecast">
          Прогноз и «что если»
        </button>
        <button role="tab" aria-selected={tab === "flow"} className={tab === "flow" ? "tab active" : "tab"} onClick={() => setTab("flow")} data-testid="tab-flow">
          Поток денег
        </button>
      </div>
      {tab === "forecast" ? <ForecastTab /> : <FlowTab />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Прогноз

const SCENARIO_KEY = "pt.forecast.scenario";

function storedScenario(): string | null {
  try {
    return localStorage.getItem(SCENARIO_KEY);
  } catch {
    return null;
  }
}

function ForecastTab() {
  const [scenarioId, setScenarioIdState] = useState<string | null>(storedScenario);
  const setScenarioId = (id: string | null) => {
    setScenarioIdState(id);
    try {
      if (id) localStorage.setItem(SCENARIO_KEY, id);
      else localStorage.removeItem(SCENARIO_KEY);
    } catch {
      /* без запоминания */
    }
  };
  const scenarios = useQuery({ queryKey: ["scenarios"], queryFn: api.listScenarios });
  // Удалённый сценарий больше не выбран.
  const known = scenarios.data?.some((s) => s.id === scenarioId) ?? true;
  const active = known ? scenarioId : null;
  const q = useQuery({ queryKey: ["forecast", active], queryFn: () => api.forecast(active) });
  const [editing, setEditing] = useState<Scenario | "new" | null>(null);
  const f = q.data;

  return (
    <>
      <div className="card scenario-bar" data-testid="scenario-bar">
        <span className="scenario-label">
          Что если
          <Hint of="forecast.scenario" />
        </span>
        <div className="fc-chips">
          <button className={active == null ? "fc-chip active" : "fc-chip"} onClick={() => setScenarioId(null)} data-testid="scenario-none">
            Как сейчас
          </button>
          {scenarios.data?.map((s) => (
            <span key={s.id} className={active === s.id ? "fc-chip active with-edit" : "fc-chip with-edit"}>
              <button className="fc-chip-main" onClick={() => setScenarioId(s.id)} data-testid="scenario-chip">
                {s.name}
              </button>
              <button className="fc-chip-edit" onClick={() => setEditing(s)} aria-label={`Изменить сценарий «${s.name}»`} title="Изменить">
                ✎
              </button>
            </span>
          ))}
          <button className="btn small" onClick={() => setEditing("new")} data-testid="scenario-new">
            + Сценарий
          </button>
        </div>
      </div>

      {q.error && <p className="error">{String(q.error)}</p>}
      {f && <ForecastView f={f} />}
      {editing && f && (
        <ScenarioForm
          scenario={editing === "new" ? null : editing}
          firstMonth={f.months[0].month}
          onClose={() => setEditing(null)}
          onSaved={(id) => setScenarioId(id)}
          onDeleted={() => setScenarioId(null)}
        />
      )}
    </>
  );
}

function ForecastView({ f }: { f: ForecastData }) {
  const last = f.months[f.months.length - 1];
  const withScenario = f.scenarioId != null;
  const end = withScenario && last.scenario ? last.scenario.closing : last.closing;
  const lowest = withScenario ? (f.scenarioLowestBalance ?? f.lowestBalance) : f.lowestBalance;
  const lowestMonth = withScenario ? lowestScenarioMonth(f) : f.lowestMonth;
  const short = withScenario ? f.scenarioShortMonth : f.shortMonth;
  const shortClosing = short ? closingOf(f, short, withScenario) : null;

  return (
    <>
      <div className="tiles">
        <div className="card tile" data-testid="fc-now">
          <div className="tile-label">Сейчас</div>
          <div className="tile-value">
            <M amount={f.liquid} />
          </div>
          <div className="hint">наличные, карты и вклады</div>
        </div>
        <div className="card tile" data-testid="fc-end">
          <div className="tile-label">Через 12 месяцев</div>
          <div className={end < 0 ? "tile-value over" : "tile-value"}>
            <M amount={end} />
          </div>
          <div className="hint">
            на конец {genitive(last.month)} · <M amount={end - f.liquid} signed />
          </div>
        </div>
        <div className="card tile" data-testid="fc-lowest">
          <div className="tile-label">Самый низкий остаток</div>
          <div className={lowest < 0 ? "tile-value over" : "tile-value"}>
            <M amount={lowest} />
          </div>
          <div className="hint">в конце {genitive(lowestMonth)}</div>
        </div>
        <div className="card tile" data-testid="fc-cushion">
          <div className="tile-label">
            Хватит на
            <Hint of="forecast.cushion" />
          </div>
          <div className="tile-value">{f.cushionTenths == null ? <span className="muted">—</span> : `${(f.cushionTenths / 10).toLocaleString("ru-RU")} мес.`}</div>
          <div className="hint">обычных трат без доходов</div>
        </div>
      </div>

      {short ? (
        <div className="card fc-alert warn" data-testid="fc-short">
          <strong>В {prepositional(short)} денег может не хватить.</strong> К концу месяца остаток уйдёт в минус: {shortClosing != null && <M amount={shortClosing} />}. Посмотрите, какие платежи можно перенести, или добавьте сценарий.
        </div>
      ) : (
        <div className="card fc-alert ok" data-testid="fc-ok">
          Денег хватает на все 12 месяцев{withScenario ? ` и в сценарии «${f.scenarioName}»` : ""}.
        </div>
      )}

      <div className="card">
        <div className="screen-head">
          <h2>
            Остаток на конец месяца
            <Hint of="forecast.chart" />
          </h2>
          {withScenario && (
            <div className="fc-legend">
              <span className="fc-key base" /> как сейчас <span className="fc-key scenario" /> {f.scenarioName}
            </div>
          )}
        </div>
        <ForecastChart f={f} />
      </div>

      <MonthsTable f={f} />
      <HowCounted f={f} />
    </>
  );
}

function lowestScenarioMonth(f: ForecastData): string {
  let best = f.months[0];
  for (const m of f.months) if ((m.scenario?.closing ?? m.closing) < (best.scenario?.closing ?? best.closing)) best = m;
  return best.month;
}

function closingOf(f: ForecastData, month: string, scenario: boolean): number | null {
  const m = f.months.find((x) => x.month === month);
  if (!m) return null;
  return scenario && m.scenario ? m.scenario.closing : m.closing;
}

const W = 900;
const H = 260;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;

function ForecastChart({ f }: { f: ForecastData }) {
  const [hover, setHover] = useState<number | null>(null);
  const hidden = useSettings().data?.hide_amounts === "1";
  const points = chartPoints(f);
  const values = points.flatMap((p) => (p.scenario == null ? [p.base] : [p.base, p.scenario]));
  const { min, max, step } = netWorthScale(values);
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
  const short = (v: number) => (hidden ? "•••" : axisLabel(v, f.minorUnits));
  const PAD_L = axisPad(ticks.map(short));
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const slot = plotW / points.length;
  const x = (i: number) => PAD_L + slot * i + slot / 2;
  const y = (v: number) => PAD_T + plotH - ((v - min) / (max - min || 1)) * plotH;
  const path = (get: (i: number) => number) => points.map((_, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(get(i)).toFixed(1)}`).join(" ");
  const base = path((i) => points[i].base);
  const area = `${base} L${x(points.length - 1).toFixed(1)} ${y(Math.max(min, 0)).toFixed(1)} L${x(0).toFixed(1)} ${y(Math.max(min, 0)).toFixed(1)} Z`;
  const scenario = f.scenarioId != null ? path((i) => points[i].scenario ?? points[i].base) : null;
  const m: ForecastMonth | null = hover != null && hover > 0 ? f.months[hover - 1] : null;

  return (
    <div className="chart nw-chart fc-chart" onMouseLeave={() => setHover(null)} data-testid="fc-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Прогноз остатка по месяцам">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} className={t === 0 ? "grid zero" : "grid"} />
            <text x={PAD_L - 8} y={y(t) + 4} className="axis" textAnchor="end">
              {short(t)}
            </text>
          </g>
        ))}
        <path d={area} className="nw-area" />
        <path d={base} className="nw-line" pathLength={1} />
        {scenario && <path d={scenario} className="fc-scenario-line" />}
        {points.map((p, i) => (
          <g key={i} onMouseEnter={() => setHover(i)}>
            <rect x={x(i) - slot / 2} y={0} width={slot} height={H} className={hover === i ? "hit active" : "hit"} />
            <circle cx={x(i)} cy={y(p.base)} r={hover === i ? 5 : 3} className={p.base < 0 ? "nw-dot neg" : "nw-dot"} />
            {p.scenario != null && i > 0 && <circle cx={x(i)} cy={y(p.scenario)} r={hover === i ? 5 : 3} className={p.scenario < 0 ? "fc-dot neg" : "fc-dot"} />}
            <text x={x(i)} y={H - 6} className="axis" textAnchor="middle">
              {p.label}
            </text>
          </g>
        ))}
      </svg>
      {hover != null && (
        <div className="tooltip nw-tip" style={{ left: `${Math.min(Math.max((x(hover) / W) * 100, 14), 86)}%` }} data-testid="fc-tip">
          {m ? (
            <>
              <div className="main">{monthTitle(m.month)}</div>
              <TipRow label="На начало" v={m.opening} />
              <TipRow label="Доходы" v={m.regularIncome + m.plannedIncome} />
              <TipRow label="Траты и платежи" v={-(m.regularExpense + m.plannedExpense)} />
              <div className="nw-tip-row total">
                <span>На конец</span>
                <M amount={m.closing} />
              </div>
              {m.scenario && (
                <div className="nw-tip-row scenario">
                  <span>{f.scenarioName}</span>
                  <M amount={m.scenario.closing} />
                </div>
              )}
            </>
          ) : (
            <>
              <div className="main">Сейчас · {formatDate(f.today)}</div>
              <TipRow label="Наличные, карты и вклады" v={f.liquid} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TipRow({ label, v }: { label: string; v: number }) {
  return (
    <div className="nw-tip-row">
      <span>{label}</span>
      <M amount={v} />
    </div>
  );
}

const ITEM_KIND: Record<ForecastItem["kind"], string> = {
  reminder: "напоминание",
  debt: "заём",
  planned: "запланировано",
  change: "сценарий",
};

function MonthsTable({ f }: { f: ForecastData }) {
  const [open, setOpen] = useState<string | null>(null);
  const withScenario = f.scenarioId != null;
  return (
    <div className="card">
      <h2>
        По месяцам
        <Hint of="forecast.months" />
      </h2>
      <table className="table fc-table" data-testid="fc-table">
        <thead>
          <tr>
            <th>Месяц</th>
            <th className="num">Доходы</th>
            <th className="num">Траты и платежи</th>
            <th className="num">На конец</th>
            {withScenario && <th className="num">{f.scenarioName}</th>}
          </tr>
        </thead>
        <tbody>
          {f.months.map((m, i) => {
            const isOpen = open === m.month;
            const items = [...m.items, ...(m.scenario?.items ?? [])].sort((a, b) => a.date.localeCompare(b.date));
            return (
              <Fragment key={m.month}>
                <tr className={isOpen ? "clickable open" : "clickable"} onClick={() => setOpen(isOpen ? null : m.month)} data-testid="fc-row">
                  <td>
                    <span className="fc-caret">{isOpen ? "▾" : "▸"}</span> {monthTitle(m.month)}
                    {i === 0 && <span className="muted"> · с {formatDate(m.start)}</span>}
                  </td>
                  <td className="num plus">
                    <M amount={m.regularIncome + m.plannedIncome} />
                  </td>
                  <td className="num">
                    <M amount={m.regularExpense + m.plannedExpense} />
                  </td>
                  <td className={m.closing < 0 ? "num over strong" : "num strong"}>
                    <M amount={m.closing} />
                  </td>
                  {withScenario && (
                    <td className={(m.scenario?.closing ?? 0) < 0 ? "num over" : "num"}>{m.scenario && <M amount={m.scenario.closing} />}</td>
                  )}
                </tr>
                {isOpen && (
                  <tr className="fc-detail">
                    <td colSpan={withScenario ? 5 : 4}>
                      <div className="fc-detail-grid">
                        <div>
                          <div className="fc-detail-row">
                            <span>Обычные доходы {i === 0 ? "(ещё ожидаются)" : "(среднее)"}</span>
                            <M amount={m.regularIncome} />
                          </div>
                          <div className="fc-detail-row">
                            <span>Обычные траты {i === 0 ? "(ещё ожидаются)" : "(среднее)"}</span>
                            <M amount={-m.regularExpense} />
                          </div>
                        </div>
                        <div>
                          {items.length === 0 ? (
                            <p className="muted">Платежей по датам нет.</p>
                          ) : (
                            items.map((it, k) => (
                              <div key={k} className={`fc-detail-row item ${it.kind}`}>
                                <span>
                                  {formatDate(it.date)} · {it.title} <span className="muted">· {ITEM_KIND[it.kind]}</span>
                                </span>
                                <M amount={it.amount} signed />
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HowCounted({ f }: { f: ForecastData }) {
  return (
    <div className="card fc-how" data-testid="fc-how">
      <h2>Как считается</h2>
      <ul>
        <li>
          Старт — деньги на наличных, картах и вкладах «в общем балансе» сегодня: <M amount={f.liquid} />.
        </li>
        <li>
          По датам: напоминания с суммой, платежи по графикам займов и запланированные операции.
        </li>
        {f.historyMonths > 0 ? (
          <li>
            Остальное — обычные доходы <M amount={f.avgIncome} /> и траты <M amount={f.avgExpense} /> в месяц: среднее за {monthsText(f.historyMonths)} без займов, поездок и событий
            {f.excludedCategories.length > 0 && <> и без категорий из напоминаний ({f.excludedCategories.join(", ")})</>}.
          </li>
        ) : (
          <li>Прошлых полных месяцев ещё нет: обычные доходы и траты появятся в прогнозе через месяц учёта.</li>
        )}
        <li>Сценарий меняет только линию «что если», ваши данные он не трогает.</li>
      </ul>
      {f.missingRates.length > 0 && <p className="hint warn">Нет курса для {f.missingRates.join(", ")}: такие суммы не вошли. Курс вводится в Настройках.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Редактор сценария

interface Row {
  kind: ChangeKind;
  title: string;
  /** Для сумм: трата или доход. */
  sign: -1 | 1;
  amount: string;
  percent: string;
  startMonth: string;
  months: string;
}

function toRow(c: ChangeInput): Row {
  return {
    kind: c.kind,
    title: c.title,
    sign: (c.amount ?? -1) < 0 ? -1 : 1,
    amount: c.amount != null ? amountToInput(Math.abs(c.amount)) : "",
    percent: c.percent != null ? String(c.percent) : "",
    startMonth: c.startMonth,
    months: c.months != null ? String(c.months) : "",
  };
}

function toChange(r: Row): ChangeInput {
  const money = r.kind === "once" || r.kind === "monthly";
  const amount = parseAmount(r.amount);
  const percent = r.percent.trim() === "" ? null : Number(r.percent.replace(",", ".").replace("−", "-"));
  const months = r.months.trim() === "" ? null : Number(r.months);
  return {
    kind: r.kind,
    title: r.title,
    amount: money && amount != null ? r.sign * Math.abs(amount) : null,
    percent: money ? null : percent != null && Number.isFinite(percent) ? Math.round(percent) : null,
    startMonth: r.startMonth,
    months: r.kind === "once" ? null : months,
  };
}

function ScenarioForm({
  scenario,
  firstMonth,
  onClose,
  onSaved,
  onDeleted,
}: {
  scenario: Scenario | null;
  firstMonth: string;
  onClose: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(scenario?.name ?? "");
  const [rows, setRows] = useState<Row[]>(() => scenario?.changes.map(toRow) ?? []);
  const save = useAction(
    (input: { name: string; changes: ChangeInput[] }) => (scenario ? api.updateScenario(scenario.id, input).then(() => scenario.id) : api.createScenario(input)),
    (id) => {
      onSaved(id);
      onClose();
    },
    { celebrate: true },
  );
  const remove = useAction(
    () => api.deleteScenario(scenario!.id),
    () => {
      onDeleted();
      onClose();
    },
  );
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const add = (c: ChangeInput) => {
    setRows((rs) => [...rs, toRow(c)]);
    if (!name.trim()) setName(c.title);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.run({ name, changes: rows.map(toChange) });
  };

  return (
    <Modal title={scenario ? "Сценарий «что если»" : "Новый сценарий «что если»"} onClose={onClose} wide>
      <form onSubmit={submit} className="scenario-form" data-testid="scenario-form">
        <Field label="Название">{(id) => <input id={id} name="scenario-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: ипотека с лета" autoFocus />}</Field>
        <div className="scenario-presets">
          <span className="muted">Быстро добавить:</span>
          {presets(firstMonth).map((p) => (
            <button type="button" key={p.label} className="fc-chip" onClick={() => add(p.change)} data-testid="scenario-preset">
              {p.label}
            </button>
          ))}
        </div>
        {rows.length === 0 && <p className="muted">Добавьте изменение кнопкой выше или «+ Изменение».</p>}
        {rows.map((r, i) => (
          <div key={i} className="scenario-row" data-testid="scenario-row">
            <select aria-label="Что меняется" value={r.kind} onChange={(e) => set(i, { kind: e.target.value as ChangeKind })}>
              {CHANGE_KINDS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <input aria-label="Подпись" className="scenario-title" value={r.title} onChange={(e) => set(i, { title: e.target.value })} placeholder="Подпись" />
            {r.kind === "once" || r.kind === "monthly" ? (
              <>
                <select aria-label="Трата или доход" value={r.sign} onChange={(e) => set(i, { sign: Number(e.target.value) as -1 | 1 })}>
                  <option value={-1}>трата</option>
                  <option value={1}>доход</option>
                </select>
                <AmountInput name="scenario-amount" value={r.amount} onChange={(v) => set(i, { amount: v })} />
              </>
            ) : (
              <span className="scenario-pct">
                <input aria-label="Процент" name="scenario-percent" inputMode="decimal" value={r.percent} onChange={(e) => set(i, { percent: e.target.value })} placeholder="−100" />%
              </span>
            )}
            <label className="scenario-when">
              {r.kind === "once" ? "в" : "с"}
              <input type="month" aria-label="Месяц" value={r.startMonth} min={shiftMonth(firstMonth, -12)} onChange={(e) => set(i, { startMonth: e.target.value })} />
            </label>
            {r.kind !== "once" && (
              <label className="scenario-when">
                на
                <input aria-label="Сколько месяцев" inputMode="numeric" className="scenario-months" value={r.months} onChange={(e) => set(i, { months: e.target.value.replace(/\D/g, "") })} placeholder="все" />
                мес.
              </label>
            )}
            <button type="button" className="icon-btn" aria-label="Убрать изменение" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>
              ×
            </button>
            <div className="scenario-desc muted">{previewText(r)}</div>
          </div>
        ))}
        <button
          type="button"
          className="btn small"
          onClick={() => setRows((rs) => [...rs, toRow({ kind: "monthly", title: "", amount: null, percent: null, startMonth: firstMonth, months: null })])}
          data-testid="scenario-add"
        >
          + Изменение
        </button>
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {scenario && (
            <button type="button" className="btn danger" onClick={() => remove.run()} disabled={remove.busy}>
              Удалить
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy} data-testid="scenario-save">
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}

function previewText(r: Row): string {
  const c = toChange(r);
  if ((c.kind === "once" || c.kind === "monthly") && !c.amount) return "";
  if ((c.kind === "income_pct" || c.kind === "expense_pct") && !c.percent) return "";
  return describeChange(c);
}

// ---------------------------------------------------------------------------
// Поток денег

function FlowTab() {
  const current = useMonthOf(today()).data?.month;
  const [kind, setKind] = useState<"month" | "year">("month");
  const [month, setMonth] = useState<string | null>(null);
  useEffect(() => {
    // По умолчанию — прошлый полный месяц: текущий ещё не закончился.
    if (!month && current) setMonth(shiftMonth(current, -1));
  }, [current, month]);
  const q = useQuery({ queryKey: ["moneyFlow", kind, month], queryFn: () => api.moneyFlow(kind, month!), enabled: !!month });
  const step = kind === "month" ? 1 : 12;
  const title = month ? (kind === "month" ? monthTitle(month) : `${month.slice(0, 4)} год`) : "";

  return (
    <div className="card" data-testid="flow-card">
      <div className="screen-head">
        <h2>
          Поток денег
          <Hint of="forecast.flow" />
        </h2>
        <div className="period-nav">
          <div className="tabs small" role="tablist">
            <button role="tab" aria-selected={kind === "month"} className={kind === "month" ? "tab active" : "tab"} onClick={() => setKind("month")}>
              Месяц
            </button>
            <button role="tab" aria-selected={kind === "year"} className={kind === "year" ? "tab active" : "tab"} onClick={() => setKind("year")}>
              Год
            </button>
          </div>
          <button className="icon-btn" aria-label="Раньше" onClick={() => month && setMonth(shiftMonth(month, -step))}>
            ‹
          </button>
          <span className="period-title" data-testid="flow-title">
            {title}
          </span>
          <button className="icon-btn" aria-label="Позже" onClick={() => month && setMonth(shiftMonth(month, step))}>
            ›
          </button>
        </div>
      </div>
      {q.error && <p className="error">{String(q.error)}</p>}
      {q.data && <FlowChart f={q.data} />}
    </div>
  );
}

const FW = 900;
const FH = 340;
const NODE_W = 12;

function FlowChart({ f }: { f: MoneyFlow }) {
  const [hover, setHover] = useState<string | null>(null);
  if (flowIsEmpty(f)) return <p className="muted" data-testid="flow-empty">За этот период доходов, расходов и вложений нет.</p>;
  const layout = flowLayout(f, FH - 20);
  const top = 10;
  const xl = 190;
  const xm = FW / 2 - NODE_W / 2;
  const xr = FW - 190 - NODE_W;
  const band = (k: string) => (hover == null || hover === k ? "flow-band" : "flow-band dim");

  return (
    <>
      <div className="flow-totals">
        <span>
          Доходы <M amount={f.totalIncome} />
        </span>
        <span>
          Расходы <M amount={f.totalExpense} />
        </span>
        {f.invested !== 0 && (
          <span>
            В инвестиции <M amount={f.invested} />
          </span>
        )}
        <span className={f.saved < 0 ? "over" : "plus"}>
          {f.saved < 0 ? "Из накоплений" : "Осталось"} <M amount={Math.abs(f.saved)} />
        </span>
      </div>
      <div className="chart flow-chart" data-testid="flow-chart" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${FW} ${FH}`} role="img" aria-label="Поток денег: откуда пришли и куда ушли">
          {layout.left.map((b) => (
            <path key={b.key} d={ribbon(xl + NODE_W, top + b.y0, top + b.y1, xm, top + b.m0, top + b.m1)} className={`${band(b.key)} ${b.kind}`} onMouseEnter={() => setHover(b.key)} />
          ))}
          {layout.right.map((b) => (
            <path key={b.key} d={ribbon(xm + NODE_W, top + b.m0, top + b.m1, xr, top + b.y0, top + b.y1)} className={`${band(b.key)} ${b.kind}`} onMouseEnter={() => setHover(b.key)} />
          ))}
          <rect x={xm} y={top} width={NODE_W} height={FH - 20} rx={3} className="flow-node mid" />
          {layout.left.map((b) => (
            <g key={b.key} onMouseEnter={() => setHover(b.key)}>
              <rect x={xl} y={top + b.y0} width={NODE_W} height={Math.max(1, b.y1 - b.y0)} rx={3} className={`flow-node ${b.kind}`} />
              <FlowLabel x={xl - 8} y={top + (b.y0 + b.y1) / 2} anchor="end" name={b.name} amount={b.amount} />
            </g>
          ))}
          {layout.right.map((b) => (
            <g key={b.key} onMouseEnter={() => setHover(b.key)}>
              <rect x={xr} y={top + b.y0} width={NODE_W} height={Math.max(1, b.y1 - b.y0)} rx={3} className={`flow-node ${b.kind}`} />
              <FlowLabel x={xr + NODE_W + 8} y={top + (b.y0 + b.y1) / 2} anchor="start" name={b.name} amount={b.amount} />
            </g>
          ))}
        </svg>
      </div>
      {f.missingRates.length > 0 && <p className="hint warn">Нет курса для {f.missingRates.join(", ")}: такие суммы не вошли.</p>}
    </>
  );
}

function FlowLabel({ x, y, anchor, name, amount }: { x: number; y: number; anchor: "start" | "end"; name: string; amount: number }) {
  const hidden = useSettings().data?.hide_amounts === "1";
  return (
    <text x={x} y={y} textAnchor={anchor} className="flow-label">
      <tspan x={x} dy="-0.15em">
        {name.length > 26 ? `${name.slice(0, 25)}…` : name}
      </tspan>
      <tspan x={x} dy="1.15em" className="flow-amount">
        {hidden ? "•••" : axisLabel(amount)}
      </tspan>
    </text>
  );
}
