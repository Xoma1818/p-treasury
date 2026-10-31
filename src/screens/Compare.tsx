import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useExport } from "../components/DataTools";
import { ErrorText } from "../components/Modal";
import { BaseMoney as M } from "../components/Money";
import { api, type CategoryKind, type CompareBy, type ComparePeriods, type CompareRow, type ReportPeriodKind } from "../lib/api";
import { barWidth, formatChange, isBetter, splitRows } from "../lib/compare";
import { shiftMonth, today } from "../lib/dates";
import { useMonthOf } from "../lib/queries";
import { useUi } from "../lib/store";

/** Готовые пары периодов: тип периода и на сколько месяцев назад первый период. */
const PRESETS: [string, ReportPeriodKind, number][] = [
  ["Месяц к прошлому", "month", 1],
  ["Месяц к тому же год назад", "month", 12],
  ["Квартал к прошлому", "quarter", 3],
  ["Год к прошлому", "year", 12],
];

const BY: [CompareBy, string][] = [
  ["category", "Категории"],
  ["payee", "Получатели"],
  ["account", "Счета"],
];

/** Вкладка «Сравнение» в Отчётах: два любых периода, что выросло и что уменьшилось. */
export function Compare() {
  const current = useMonthOf(today()).data?.month;
  const [periods, setPeriods] = useState<ComparePeriods | null>(null);
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [by, setBy] = useState<CompareBy>("category");
  const [preset, setPreset] = useState(0);

  const applyPreset = async (i: number) => {
    if (!current) return;
    const [, k, back] = PRESETS[i];
    const [b, a] = await Promise.all([api.reportPeriod(k, current), api.reportPeriod(k, shiftMonth(current, -back))]);
    setPreset(i);
    setPeriods({ aFrom: a.start, aTo: a.end, bFrom: b.start, bTo: b.end });
  };
  useEffect(() => {
    if (current && !periods) applyPreset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const valid = !!periods && periods.aFrom <= periods.aTo && periods.bFrom <= periods.bTo;
  const cmp = useQuery({
    queryKey: ["comparePeriods", kind, by, periods],
    queryFn: () => api.comparePeriods(kind, by, periods!),
    enabled: valid,
  });
  const exp = useExport(`P-Treasury — сравнение ${periods ? `${periods.aFrom} — ${periods.aTo} и ${periods.bFrom} — ${periods.bTo}` : ""}`, async (path) => {
    if (periods) await api.exportComparison(kind, by, periods, path);
  });
  const edit = (k: keyof ComparePeriods, v: string) => {
    if (!v || !periods) return;
    setPreset(-1);
    setPeriods({ ...periods, [k]: v });
  };
  const c = cmp.data;

  return (
    <div className="compare" data-testid="compare">
      <div className="card compare-head">
        <div className="presets" role="group" aria-label="Готовые пары периодов">
          {PRESETS.map(([label], i) => (
            <button key={label} className={preset === i ? "chip-btn active" : "chip-btn"} onClick={() => applyPreset(i)}>
              {label}
            </button>
          ))}
        </div>
        {periods && (
          <div className="compare-periods">
            <PeriodBox n={1} from={periods.aFrom} to={periods.aTo} onFrom={(v) => edit("aFrom", v)} onTo={(v) => edit("aTo", v)} />
            <span className="vs muted" aria-hidden>→</span>
            <PeriodBox n={2} from={periods.bFrom} to={periods.bTo} onFrom={(v) => edit("bFrom", v)} onTo={(v) => edit("bTo", v)} />
            <button className="btn" onClick={exp.run} aria-busy={exp.busy} data-done={exp.done || undefined} disabled={exp.busy || !valid} title="Сравнение в Excel или CSV">
              Выгрузить
            </button>
          </div>
        )}
        {periods && !valid && <p className="error">Конец периода раньше начала.</p>}
        {periods && periods.bTo >= today() && periods.bFrom <= today() && (
          <p className="hint">Период 2 ещё идёт: суммы в нём могут вырасти до конца периода.</p>
        )}
        {exp.done && (
          <p className="ok" data-testid="export-done">
            Выгружено: {exp.done}
          </p>
        )}
        <ErrorText error={exp.error ?? (cmp.error ? String(cmp.error) : null)} />
      </div>

      {c && (
        <div className="tiles three">
          <Tile label="Доходы" a={c.summaryA.income} b={c.summaryB.income} better={(d) => d > 0} testid="cmp-income" />
          <Tile label="Расходы" a={c.summaryA.expense} b={c.summaryB.expense} better={(d) => d < 0} testid="cmp-expense" />
          <Tile
            label="Сальдо"
            a={c.summaryA.income - c.summaryA.expense}
            b={c.summaryB.income - c.summaryB.expense}
            better={(d) => d > 0}
            testid="cmp-balance"
            signed
          />
        </div>
      )}

      <div className="card">
        <div className="screen-head">
          <h2>{kind === "expense" ? "Что изменилось в расходах" : "Что изменилось в доходах"}</h2>
          <div className="compare-switches">
            <div className="tabs small">
              {(["expense", "income"] as CategoryKind[]).map((k) => (
                <button key={k} className={kind === k ? "tab active" : "tab"} onClick={() => setKind(k)}>
                  {k === "expense" ? "Расходы" : "Доходы"}
                </button>
              ))}
            </div>
            <div className="tabs small" aria-label="Сравнивать по">
              {BY.map(([k, label]) => (
                <button key={k} className={by === k ? "tab active" : "tab"} onClick={() => setBy(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {c && periods && <Changes c={c.rows} kind={kind} by={by} periods={periods} total={[c.totalA, c.totalB, c.diff, c.percent]} />}
        {c && c.missingRates.length > 0 && <p className="hint warn">Нет курса для {c.missingRates.join(", ")}: такие операции не вошли.</p>}
      </div>
    </div>
  );
}

function PeriodBox({ n, from, to, onFrom, onTo }: { n: number; from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  return (
    <div className={`period-box p${n}`} data-testid={`period-${n}`}>
      <div className="tile-label">Период {n}</div>
      <div className="period-dates">
        <input type="date" name={`cmp${n}From`} aria-label={`Период ${n}: с даты`} value={from} onChange={(e) => onFrom(e.target.value)} />
        <span className="muted">—</span>
        <input type="date" name={`cmp${n}To`} aria-label={`Период ${n}: по дату`} value={to} onChange={(e) => onTo(e.target.value)} />
      </div>
    </div>
  );
}

function Tile({ label, a, b, better, testid, signed }: { label: string; a: number; b: number; better: (d: number) => boolean; testid: string; signed?: boolean }) {
  const d = b - a;
  const pct = a ? Math.round((d / Math.abs(a)) * 100) : null;
  return (
    <div className="card tile" data-testid={testid}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        <M amount={b} signed={signed} />
      </div>
      <div className="hint">
        было <M amount={a} signed={signed} />
      </div>
      <div className={d === 0 ? "change" : better(d) ? "change better" : "change worse"} data-testid={`${testid}-diff`}>
        {d === 0 ? "без изменений" : <><M amount={d} signed />{pct != null && ` (${formatChange(pct)})`}</>}
      </div>
    </div>
  );
}

type Total = [number, number, number, number | null];

function Changes({ c, kind, by, periods, total }: { c: CompareRow[]; kind: CategoryKind; by: CompareBy; periods: ComparePeriods; total: Total }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const showTransactions = useUi((u) => u.showTransactions);
  if (c.length === 0) return <p className="muted">В обоих периодах операций нет.</p>;
  const groups = splitRows(c);
  const max = Math.max(...c.map((r) => Math.abs(r.diff)));
  const appeared = c.filter((r) => r.presence === "onlyB").length;
  const gone = c.filter((r) => r.presence === "onlyA").length;
  const go = (r: CompareRow) =>
    showTransactions({
      dateFrom: periods.bFrom,
      dateTo: periods.bTo,
      ...(by === "category" ? { categoryId: r.key } : by === "account" ? { accountId: r.key } : r.key ? { search: r.key } : {}),
    });
  const toggle = (k: string) =>
    setOpen((o) => {
      const s = new Set(o);
      if (s.has(k)) s.delete(k);
      else s.add(k);
      return s;
    });

  const line = (r: CompareRow, child = false) => {
    const tone = r.diff === 0 ? "" : isBetter(kind, r.diff) ? "better" : "worse";
    const w = barWidth(r.diff, max);
    return (
      <li key={child ? `c-${r.key}` : r.key} className={child ? "cmp-row child" : "cmp-row"} data-testid={child ? "cmp-child" : "cmp-row"} data-name={r.name} data-presence={r.presence}>
        <span className="cat-name">
          {!child && r.children.length > 0 ? (
            <button className="icon-btn small" aria-label={open.has(r.key) ? "Свернуть" : "Раскрыть"} aria-expanded={open.has(r.key)} onClick={() => toggle(r.key)}>
              {open.has(r.key) ? <ChevronDown size={14} strokeWidth={2} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />}
            </button>
          ) : (
            <span className="icon-gap" />
          )}
          {child ? (
            <span>{r.name}</span>
          ) : (
            <button className="link cat-link" title="Операции периода 2" onClick={() => go(r)}>
              {r.name}
            </button>
          )}
          {r.presence === "onlyB" && <span className="badge good">новое</span>}
          {r.presence === "onlyA" && <span className="badge">нет в периоде 2</span>}
        </span>
        <span className="num muted" data-testid="cmp-a">
          <M amount={r.a} />
        </span>
        <span className="num" data-testid="cmp-b">
          <M amount={r.b} />
        </span>
        <span className="diverge" title={`${r.name}: было ${r.a / 100}, стало ${r.b / 100}`} aria-hidden>
          <span className="axis" />
          {w > 0 && <span className={`dbar ${r.diff > 0 ? "up" : "down"} ${tone}`} style={{ width: `${w / 2}%` }} />}
        </span>
        <span className={`num change ${tone}`} data-testid="cmp-diff">
          {r.diff === 0 ? "—" : <M amount={r.diff} signed />}
        </span>
        <span className={`num change ${tone}`} data-testid="cmp-percent">
          {r.diff === 0 && r.percent === 0 ? "0 %" : formatChange(r.percent)}
        </span>
      </li>
    );
  };
  const section = (title: string, rows: CompareRow[], testid: string) =>
    rows.length > 0 && (
      <div className="cmp-section" data-testid={testid}>
        <h3>
          {title} <span className="muted">({rows.length})</span>
        </h3>
        <ul className="cmp-list">{rows.map((r) => [line(r), ...(open.has(r.key) ? r.children.map((x) => line(x, true)) : [])])}</ul>
      </div>
    );

  return (
    <>
      <div className="cmp-legend muted">
        <span>
          <i className="swatch better" /> {kind === "expense" ? "тратите меньше" : "получаете больше"}
          <i className="swatch worse" /> {kind === "expense" ? "тратите больше" : "получаете меньше"}
        </span>
        {(appeared > 0 || gone > 0) && (
          <span data-testid="cmp-presence">
            Новых позиций: {appeared}, пропало: {gone}
          </span>
        )}
      </div>
      <div className="cmp-row head muted" aria-hidden>
        <span>{by === "category" ? "Категория" : by === "payee" ? "Получатель" : "Счёт"}</span>
        <span className="num">Период 1</span>
        <span className="num">Период 2</span>
        <span className="diverge-head">
          <span>меньше</span>
          <span>больше</span>
        </span>
        <span className="num">Изменение</span>
        <span className="num">%</span>
      </div>
      {section("Стало больше", groups.up, "cmp-up")}
      {section("Стало меньше", groups.down, "cmp-down")}
      {section("Без изменений", groups.same, "cmp-same")}
      <div className="table-foot cmp-total" data-testid="cmp-total">
        Итого: <M amount={total[0]} /> → <M amount={total[1]} />, изменение <M amount={total[2]} signed /> {total[3] != null && ` (${formatChange(total[3])})`}. Нажмите на позицию, чтобы увидеть её операции за период 2.
      </div>
    </>
  );
}
