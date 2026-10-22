import { useState } from "react";
import { Field } from "../../components/Fields";
import { Hint } from "../../components/Hint";
import { ErrorText, Modal } from "../../components/Modal";
import { api, type CalcInput, type DebtCard, type ScheduleDoc } from "../../lib/api";
import { baseName, PDF, pickSave, XLSX } from "../../lib/files";
import { useSettings } from "../../lib/queries";
import { useAction } from "../../lib/useAction";

export type ExportSource = { kind: "calc"; input: CalcInput; currency: string } | { kind: "debt"; card: DebtCard };
export type ExportFormat = "pdf" | "xlsx";

/** Ваша сторона в документе: займодавец, если вы дали в долг (или считаете расчёт), иначе заёмщик. */
const meIsLender = (s: ExportSource) => s.kind === "calc" || s.card.direction === "lent";

/** Документ графика из ядра: по расчёту без записи или по займу. */
function loadDoc(s: ExportSource, withForecast: boolean): Promise<ScheduleDoc> {
  return s.kind === "calc" ? api.calcScheduleDoc(s.input, s.currency) : api.debtScheduleDoc(s.card.id, withForecast);
}

/** Выбрать путь и записать график в Excel или PDF. `null` — пользователь передумал. */
export async function exportSchedule(s: ExportSource, format: ExportFormat, opts: { lender?: string; borrower?: string; withSignatures?: boolean; withForecast?: boolean } = {}): Promise<string | null> {
  const name = s.kind === "calc" ? "График платежей (расчёт)" : `График платежей — ${s.card.counterparty.replace(/[\\/:*?"<>|]/g, " ")}`;
  const path = await pickSave(`${name}.${format}`, [format === "pdf" ? PDF : XLSX]);
  if (!path) return null;
  const doc = await loadDoc(s, !!opts.withForecast);
  const patched: ScheduleDoc = {
    ...doc,
    lenderName: opts.lender ?? doc.lenderName,
    borrowerName: opts.borrower ?? doc.borrowerName,
    withSignatures: opts.withSignatures ?? doc.withSignatures,
  };
  await (format === "pdf" ? api.exportSchedulePdf(path, patched) : api.exportScheduleXlsx(path, patched));
  return path;
}

/** Диалог выгрузки графика: ФИО сторон (ваше запоминается в настройке loan_lender_name),
 *  «с подписями», для займа — «с прогнозом досрочек» и выбор PDF / Excel. */
export function ExportDialog({ source, format: initial, onClose, onSaved }: { source: ExportSource; format: ExportFormat; onClose: () => void; onSaved: (path: string) => void }) {
  const settings = useSettings().data;
  const me = settings?.loan_lender_name ?? "";
  const lenderMe = meIsLender(source);
  const other = source.kind === "debt" ? source.card.counterparty : "";
  const [format, setFormat] = useState<ExportFormat>(initial);
  const [lender, setLender] = useState(lenderMe ? me : other);
  const [borrower, setBorrower] = useState(lenderMe ? other : me);
  const [signatures, setSignatures] = useState(true);
  const [forecast, setForecast] = useState(false);
  const save = useAction(
    async () => {
      const mine = (lenderMe ? lender : borrower).trim();
      const path = await exportSchedule(source, format, { lender: lender.trim(), borrower: borrower.trim(), withSignatures: format === "pdf" ? signatures : false, withForecast: forecast });
      if (path && mine !== me) await api.setSetting("loan_lender_name", mine);
      return path;
    },
    (path) => path && onSaved(path),
    { celebrate: true },
  );
  const hasPlanned = source.kind === "debt";

  return (
    <Modal title={format === "pdf" ? "График в PDF" : "График в Excel"} onClose={onClose}>
      <form className="form" data-testid="export-dialog" onSubmit={(e) => (e.preventDefault(), save.run())}>
        {source.kind === "debt" && (
          <div className="tabs small" role="tablist" aria-label="Формат">
            {(
              [
                ["pdf", "PDF для подписи"],
                ["xlsx", "Excel"],
              ] as [ExportFormat, string][]
            ).map(([f, label]) => (
              <button key={f} type="button" role="tab" aria-selected={format === f} className={format === f ? "tab active" : "tab"} onClick={() => setFormat(f)}>
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="row">
          <Field label={lenderMe ? "Займодавец (вы)" : "Займодавец"} help="pdf.names">
            {(id) => <input id={id} name="lenderName" value={lender} onChange={(e) => setLender(e.target.value)} placeholder="Фамилия Имя Отчество" autoFocus />}
          </Field>
          <Field label={lenderMe ? "Заёмщик" : "Заёмщик (вы)"}>{(id) => <input id={id} name="borrowerName" value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="Фамилия Имя Отчество" />}</Field>
        </div>
        {format === "pdf" && (
          <label className="check">
            <input type="checkbox" name="withSignatures" checked={signatures} onChange={(e) => setSignatures(e.target.checked)} /> С подписями сторон
            <Hint of="pdf.signatures" />
          </label>
        )}
        {hasPlanned && (
          <label className="check">
            <input type="checkbox" name="withForecast" checked={forecast} onChange={(e) => setForecast(e.target.checked)} /> С прогнозом плановых досрочек
            <Hint of="pdf.forecast" />
          </label>
        )}
        <p className="hint">Ваше ФИО запомнится для следующих графиков.</p>
        <ErrorText error={save.error} />
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy}>
            Сохранить файл
          </button>
        </div>
      </form>
    </Modal>
  );
}

export const savedText = (path: string) => `Сохранено: ${baseName(path)}`;
