import { useState } from "react";
import { useStore } from "zustand";
import { amountPrivacy } from "../lib/amountPrivacy";
import { useSettings } from "../lib/queries";
import { useFine } from "../lib/fine";
import { formatMoney, HIDDEN_AMOUNT } from "../lib/money";

/** Локальное раскрытие действует только для текущего документа и текущего сеанса приватности. */
export function useFormAmounts(scope: object | string) {
  const settings = useSettings().data;
  const privateMode = settings?.hide_amounts === "1";
  const protection = useStore(amountPrivacy.state);
  const [revealedFor, setRevealedFor] = useState<{scope: object | string; generation: number} | null>(null);
  const revealed = privateMode && !protection.masked && revealedFor?.scope === scope && revealedFor.generation === protection.generation;
  if (revealedFor !== null && !revealed) setRevealedFor(null);
  return {
    concealed: !settings || (privateMode && !revealed),
    privateMode,
    locked: protection.masked,
    conceal: () => setRevealedFor(null),
    toggle: () => setRevealedFor(revealed || protection.masked ? null : { scope, generation: protection.generation }),
  };
}

export function FormAmountsToggle({ privacy, where = "в этой форме" }: { privacy: ReturnType<typeof useFormAmounts>; where?: string }) {
  if (!privacy.privateMode) return null;
  return (
    <button type="button" className="link" disabled={privacy.locked} data-testid="form-amounts-toggle" onClick={privacy.toggle}>
      {privacy.concealed ? "Показать" : "Скрыть"} суммы {where}
    </button>
  );
}

/** Тот же формат, что у Money. Вывод и подсказки разделяют разрешение конкретной формы. */
export function useFormMoney(privacy: ReturnType<typeof useFormAmounts>, code: string, symbol: string, minorUnits: number) {
  const label = useFine().code ? code : symbol;
  return (amount: number, signed = false) => privacy.concealed ? HIDDEN_AMOUNT
    : (signed && amount > 0 ? "+" : "") + formatMoney(amount, label, minorUnits);
}
