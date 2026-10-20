import { ACCOUNT_TYPES, type AccountType } from "../lib/api";

export function AccountSelectType({ id, name, value, onChange }: { id?: string; name: string; value: AccountType; onChange: (t: AccountType) => void }) {
  return (
    <select id={id} aria-label="Тип счёта" name={name} value={value} onChange={(e) => onChange(e.target.value as AccountType)}>
      {(Object.keys(ACCOUNT_TYPES) as AccountType[]).map((t) => (
        <option key={t} value={t}>
          {ACCOUNT_TYPES[t]}
        </option>
      ))}
    </select>
  );
}
