import { useState } from "react";
import { api, type CbrImport } from "../lib/api";
import { formatDate, today } from "../lib/dates";
import { describeCbrImport } from "../lib/rates";
import { useAction } from "../lib/useAction";

/** Кнопка «Обновить курсы ЦБ»: скачивает официальные курсы на дату и показывает итог. */
export function CbrButton({
  date = today(),
  small,
  label = "Обновить курсы ЦБ",
  onLoaded,
}: {
  date?: string;
  small?: boolean;
  label?: string;
  onLoaded?: () => void;
}) {
  const [result, setResult] = useState<CbrImport | null>(null);
  const load = useAction(api.loadCbrRates, (r) => (setResult(r), onLoaded?.()));
  const message = result && describeCbrImport(result, formatDate);
  return (
    <div className="cbr">
      <button
        type="button"
        className={small ? "btn small" : "btn primary"}
        data-testid="cbr-load"
        aria-busy={load.busy} data-done={load.done || undefined}
        disabled={load.busy}
        onClick={() => (setResult(null), onLoaded?.(), load.run(date))}
      >
        <span className="btn-icon" aria-hidden="true">
          ↻
        </span>
        {load.busy ? "Загружаю…" : label}
      </button>
      {message && (
        <span className={message.ok ? "cbr-result ok" : "cbr-result warn"} role="status" data-testid="cbr-result">
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
