import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { useCategories } from "../lib/queries";
import { useAction } from "../lib/useAction";
import { CategorySelect } from "./Fields";
import { ErrorText } from "./Modal";

/**
 * Правила автокатегорий: «если в получателе есть „пятерочка“ — категория Продукты».
 * Работают в быстром вводе, в тексте SMS и при импорте CSV без категории.
 */
export function RulesCard() {
  const rules = useQuery({ queryKey: ["rules"], queryFn: api.listRules }).data ?? [];
  const categories = useCategories().data ?? [];
  const [pattern, setPattern] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [payee, setPayee] = useState("");
  const create = useAction(
    () => api.createRule({ pattern, categoryId, payee: payee.trim() || null }),
    () => {
      setPattern("");
      setPayee("");
    },
  );
  const remove = useAction(api.deleteRule);

  return (
    <div className="card" data-testid="rules">
      <h2>Правила автокатегорий</h2>
      <p className="muted">
        Если в названии магазина есть этот текст, категория подставится сама: в быстром вводе, в SMS банка и при загрузке CSV. Правило
        можно запомнить и прямо из быстрого ввода.
      </p>
      {rules.length > 0 && (
        <table className="table rules-table">
          <thead>
            <tr>
              <th>Текст в названии</th>
              <th>Категория</th>
              <th>Получатель</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} data-testid="rule-row">
                <td>{r.pattern}</td>
                <td>{r.categoryName}</td>
                <td className="muted">{r.payee ?? "как в тексте"}</td>
                <td>
                  <button className="link danger" onClick={() => remove.run(r.id)} aria-label={`Удалить правило «${r.pattern}»`}>
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="rules-form"
        onSubmit={(e) => {
          e.preventDefault();
          create.run();
        }}
      >
        <input name="rulePattern" placeholder="Текст, например «пятерочка»" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <CategorySelect name="ruleCategory" categories={categories} value={categoryId} onChange={setCategoryId} />
        <input name="rulePayee" placeholder="Получатель (необязательно)" value={payee} onChange={(e) => setPayee(e.target.value)} />
        <button className="btn" type="submit" disabled={!pattern.trim() || !categoryId || create.busy}>
          Добавить правило
        </button>
      </form>
      <ErrorText error={create.error ?? remove.error} />
    </div>
  );
}
