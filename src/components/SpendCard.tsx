import { useAccounts, useCategories } from "../lib/queries";
import { spendAccount } from "../lib/directDrag";
import { useUi } from "../lib/store";
import { Hint } from "./Hint";

/**
 * «Куда тратите»: частые категории расходов. Нажатие открывает расход в категории,
 * а счёт, перетащенный сюда со списка «Счета», подставляется в форму.
 */
export function SpendCard() {
  const categories = useCategories().data ?? [];
  const openTxnForm = useUi((s) => s.openTxnForm);
  const accounts = useAccounts().data;
  const top = categories
    .filter((c) => c.kind === "expense" && !c.archived)
    .sort((a, b) => b.transactionCount - a.transactionCount || a.name.localeCompare(b.name))
    .slice(0, 10);
  const open = (categoryId: string, accountId?: string) => openTxnForm({ mode: "new", type: "expense", prefill: { categoryId, accountId } });
  return (
    <div className="card" data-testid="home-spend">
      <h2>
        Куда тратите
        <Hint of="spend" />
      </h2>
      <p className="hint">Нажмите на категорию или перетащите на неё счёт из списка «Счета».</p>
      <div className="spend-chips">
        {top.map((c) => (
          <button
            key={c.id}
            className="spend-chip"
            data-testid="spend-chip"
            data-category={c.name}
            onClick={() => open(c.id)}
            {...spendAccount.target((id) => !!accounts?.some((a) => a.id === id && !a.archived), (id) => open(c.id, id))}
          >
            {c.name}
          </button>
        ))}
      </div>
    </div>
  );
}
