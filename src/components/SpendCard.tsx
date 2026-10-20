import { useState } from "react";
import { useCategories } from "../lib/queries";
import { useUi } from "../lib/store";

/** Тип данных перетаскивания счёта на категорию. */
export const ACCOUNT_DRAG = "application/x-p-treasury-account";

/**
 * «Куда тратите»: частые категории расходов. Нажатие открывает расход в категории,
 * а счёт, перетащенный сюда со списка «Счета», подставляется в форму.
 */
export function SpendCard() {
  const categories = useCategories().data ?? [];
  const openTxnForm = useUi((s) => s.openTxnForm);
  const [over, setOver] = useState<string | null>(null);
  const top = categories
    .filter((c) => c.kind === "expense" && !c.archived)
    .sort((a, b) => b.transactionCount - a.transactionCount || a.name.localeCompare(b.name))
    .slice(0, 10);
  const open = (categoryId: string, accountId?: string) => openTxnForm({ mode: "new", type: "expense", prefill: { categoryId, accountId } });
  return (
    <div className="card" data-testid="home-spend">
      <h2>Куда тратите</h2>
      <p className="hint">Нажмите на категорию или перетащите на неё счёт из списка «Счета».</p>
      <div className="spend-chips">
        {top.map((c) => (
          <button
            key={c.id}
            className={over === c.id ? "spend-chip drop-over" : "spend-chip"}
            data-testid="spend-chip"
            data-category={c.name}
            onClick={() => open(c.id)}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(ACCOUNT_DRAG)) return;
              e.preventDefault();
              setOver(c.id);
            }}
            onDragLeave={() => setOver((cur) => (cur === c.id ? null : cur))}
            onDrop={(e) => {
              const account = e.dataTransfer.getData(ACCOUNT_DRAG);
              setOver(null);
              if (account) open(c.id, account);
            }}
          >
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}
