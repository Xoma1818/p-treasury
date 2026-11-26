import { useState } from "react";
import { api, type CbrImport } from "../lib/api";
import { formatDate, today } from "../lib/dates";
import { describeCbrImport } from "../lib/rates";
import { useAction } from "../lib/useAction";

/** Кнопка «Обновить курсы ЦБ»: скачивает официальные курсы на дату и показывает итог. */
export function CbrButton({
  date,
  small,
  label = "Обновить курсы ЦБ",
  onLoaded,
}: {
  /** Дата курсов; без неё — сегодня на момент нажатия (экран мог простоять за полночь). */
  date?: string;
  small?: boolean;
  label?: string;
  onLoaded?: () => void;
}) {
  const [result, setResult] = useState<CbrImport | null>(null);
  const load = useAction(api.loadCbrRates, (r) => (setResult(r), onLoaded?.()), { singleSubmit: true, networkMode: "always" });
  const message = result && describeCbrImport(result, formatDate);
  const complete = result !== null && result.updated.length > 0 && result.missing.length === 0;
  return (
    <div className="cbr">
      <button
        type="button"
        className={small ? "btn small" : "btn primary"}
        data-testid="cbr-load"
        aria-busy={load.busy} data-done={load.done && complete || undefined}
        disabled={load.busy}
        onClick={() => (setResult(null), onLoaded?.(), load.run(date ?? today()))}
      >
        <span className="btn-icon" aria-hidden="true">
          ↻
        </span>
        {load.busy ? "Загружаю…" : label}
      </button>
      {message && (
        <span className={complete ? "cbr-result ok" : result?.missing.length ? "cbr-result warn" : "cbr-result muted"} role="status" data-testid="cbr-result">
          {message.text}
        </span>
      )}
      {load.error && (
        <span className="cbr-result error" role="alert" data-testid="cbr-error">
          {load.error}
        </span>
      )}
    </div>
  );
}
