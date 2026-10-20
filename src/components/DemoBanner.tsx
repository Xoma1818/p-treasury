import { useState } from "react";
import { api } from "../lib/api";
import { useSettings } from "../lib/queries";
import { useUi } from "../lib/store";
import { useAction } from "../lib/useAction";
import { ErrorText } from "./Modal";

/** Плашка над экранами, пока открыт пример: удалить его и начать своё. */
export function DemoBanner() {
  const demo = useSettings().data?.demo_data === "1";
  const [confirm, setConfirm] = useState(false);
  const clear = useAction(api.clearDemo, () => useUi.getState().go("home"));
  if (!demo) return null;
  return (
    <div className="card banner demo-banner" data-testid="demo-banner">
      <span>
        <b>Это пример:</b> счета и операции придуманы, чтобы показать, как всё выглядит.
      </span>
      {confirm ? (
        <span className="btn-group">
          <button className="btn danger" onClick={() => clear.run()} aria-busy={clear.busy} disabled={clear.busy}>
            Да, удалить пример
          </button>
          <button className="btn" onClick={() => setConfirm(false)}>
            Отмена
          </button>
        </span>
      ) : (
        <button className="btn primary" onClick={() => setConfirm(true)}>
          Удалить пример и начать своё
        </button>
      )}
      <ErrorText error={clear.error} />
    </div>
  );
}
