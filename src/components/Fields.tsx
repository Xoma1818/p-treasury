import { memo, useCallback, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import type { Account, Category, CategoryKind } from "../lib/api";
import type { HintKey } from "../lib/hints";
import { Hint } from "./Hint";
import { amountToInput, formatAmount, HIDDEN_AMOUNT, isExpression, parseAmount } from "../lib/money";

/** Поле с подписью; `help` — значок «?» с подсказкой из hints.ts у подписи. */
export function Field({ label, children, hint, help }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode; help?: HintKey }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {help && <Hint of={help} />}
      </label>
      {children(id)}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

type AmountInputProps = {
  id?: string;
  name: string;
  value: string;
  onChange: (text: string) => void;
  minorUnits?: number;
  allowNegative?: boolean;
  autoFocus?: boolean;
  concealed?: boolean;
};

export function AmountInput({ onChange, ...props }: AmountInputProps) {
  // Редакторы строк передают новый обработчик при обновлении формы.
  const latestChange = useRef(onChange);
  useLayoutEffect(() => { latestChange.current = onChange; }, [onChange]);
  const change = useCallback((text: string) => latestChange.current(text), []);
  return <AmountField {...props} onChange={change} />;
}

// В WebKit посторонняя отрисовка формы может вернуть прежний текст между
// нативным изменением поля и событием input. Обновляем поле при изменении его свойств.
const AmountField = memo(function AmountField({
  id, name, value, onChange, minorUnits = 2, allowNegative = false, autoFocus, concealed = false,
}: AmountInputProps) {
  const parsed = parseAmount(value, minorUnits);
  const bad = !concealed && value.trim() !== "" && (parsed === null || (!allowNegative && parsed < 0));
  const calc = !concealed && !bad && parsed !== null && isExpression(value);
  return (
    <span className="amount-field">
      <input
        id={id}
        name={name}
        className={bad ? "amount invalid" : "amount"}
        inputMode="decimal"
        autoComplete="off"
        value={concealed ? HIDDEN_AMOUNT : value}
        readOnly={concealed}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        // Уход с поля заменяет выражение результатом: «1890+455» → «2345».
        onBlur={() => calc && onChange(amountToInput(parsed, minorUnits))}
      />
      {calc && (
        <span className="amount-calc" data-testid={`${name}-calc`}>
          = {formatAmount(parsed, minorUnits)}
        </span>
      )}
    </span>
  );
});

export const amountText = (v: number | null | undefined, minorUnits = 2) => (v == null ? "" : amountToInput(v, minorUnits));

export function AccountSelect({
  id,
  name,
  accounts,
  value,
  onChange,
  placeholder = "Выберите счёт",
  exclude,
  children,
}: {
  id?: string;
  name: string;
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  exclude?: string;
  children?: ReactNode;
}) {
  return (
    <select id={id} name={name} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {children}
      {accounts
        .filter((a) => a.id !== exclude && (!a.archived || a.id === value))
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.currencySymbol})
          </option>
        ))}
    </select>
  );
}

export function CategorySelect({
  id,
  name,
  categories,
  kind,
  value,
  onChange,
  placeholder = "Выберите категорию",
  exclude,
}: {
  id?: string;
  name: string;
  categories: Category[];
  kind?: CategoryKind;
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  exclude?: (c: Category) => boolean;
}) {
  return (
    <select id={id} name={name} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {categories
        .filter((c) => (!kind || c.kind === kind) && !(exclude && exclude(c)))
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.parentId ? ` ${c.name}` : c.name}
          </option>
        ))}
    </select>
  );
}
