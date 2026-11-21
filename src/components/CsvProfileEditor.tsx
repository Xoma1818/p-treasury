import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Account, type CsvDateFormat, type CsvDelimiter, type CsvEncoding, type CsvMapping } from "../lib/api";
import { AccountSelect, Field } from "./Fields";
import { ErrorText } from "./Modal";

type Column = number | null;
type Columns = {
  date: Column;
  signed: Column;
  debit: Column;
  credit: Column;
  payee: Column;
  note: Column;
  currency: Column;
};

const EMPTY_COLUMNS: Columns = {
  date: null, signed: null, debit: null, credit: null, payee: null, note: null, currency: null,
};
const profileKey = ["csv-import-profiles"] as const;

function columnsOf(mapping: CsvMapping): Columns {
  const { amount, date, payee, note, currency } = mapping;
  return {
    date, payee, note, currency,
    signed: amount.kind === "signed" ? amount.column : null,
    debit: amount.kind === "debitCredit" ? amount.debit : null,
    credit: amount.kind === "debitCredit" ? amount.credit : null,
  };
}

function sameHeaders(a: string[], b: string[]) {
  return a.length === b.length && a.every((header, index) => header === b[index]);
}

type Applied = { mapping: CsvMapping; accountId: string };

export function CsvProfileEditor({ path, accounts, initial, pending, onPreview, onClose }: {
  path: string;
  accounts: Account[];
  initial: Applied | null;
  pending: boolean;
  onPreview: (applied: Applied) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [accountId, setAccountId] = useState(initial?.accountId ?? "");
  const [delimiter, setDelimiter] = useState<CsvDelimiter | undefined>(initial?.mapping.delimiter);
  const [encoding, setEncoding] = useState<CsvEncoding | undefined>(initial?.mapping.encoding);
  const [dateFormat, setDateFormat] = useState<CsvDateFormat>(initial?.mapping.dateFormat ?? "standard");
  const [amountKind, setAmountKind] = useState<CsvMapping["amount"]["kind"]>(initial?.mapping.amount.kind ?? "signed");
  const [columns, setColumns] = useState<Columns>(() => initial ? columnsOf(initial.mapping) : EMPTY_COLUMNS);
  const [expectedHeaders, setExpectedHeaders] = useState<string[] | null>(initial?.mapping.headers ?? null);
  const [profileId, setProfileId] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  const sample = useQuery({
    queryKey: ["csv-sample", path, delimiter, encoding],
    queryFn: () => api.inspectCsvProfile(path, delimiter, encoding),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const profiles = useQuery({ queryKey: profileKey, queryFn: api.listCsvProfiles });
  const saveProfile = useMutation({
    mutationFn: (mapping: CsvMapping) => api.saveCsvProfile(path, profileId || null, name, accountId, mapping),
    onMutate: () => setMessage(""),
    onSuccess: async (profile) => {
      setProfileId(profile.id);
      setName(profile.name);
      await qc.invalidateQueries({ queryKey: profileKey });
      setMessage("Профиль сохранён.");
    },
  });
  const deleteProfile = useMutation({
    mutationFn: api.deleteCsvProfile,
    onMutate: () => setMessage(""),
    onSuccess: async () => {
      setProfileId("");
      setName("");
      await qc.invalidateQueries({ queryKey: profileKey });
      setMessage("Профиль удалён.");
    },
  });

  const openProfile = (id: string) => {
    setProfileId(id);
    setMessage("");
    const profile = profiles.data?.find((p) => p.id === id);
    if (!profile) {
      setName("");
      return;
    }
    const m = profile.mapping;
    setName(profile.name);
    setAccountId(profile.accountId);
    setDateFormat(m.dateFormat);
    setAmountKind(m.amount.kind);
    setEncoding(m.encoding);
    setDelimiter(m.delimiter);
    setExpectedHeaders(m.headers);
    setColumns(columnsOf(m));
  };

  const headers = sample.data?.headers;
  const headersChanged = !!headers && !!expectedHeaders && !sameHeaders(headers, expectedHeaders);
  const busy = pending || saveProfile.isPending || deleteProfile.isPending;
  const amount = amountKind === "signed"
    ? columns.signed == null ? null : { kind: "signed" as const, column: columns.signed }
    : columns.debit == null || columns.credit == null
      ? null
      : { kind: "debitCredit" as const, debit: columns.debit, credit: columns.credit };
  const mappedColumns = [
    columns.date, columns.payee, columns.note, columns.currency,
    ...(amount?.kind === "signed" ? [amount.column] : amount ? [amount.debit, amount.credit] : []),
  ].filter((column): column is number => column !== null);
  const repeatedColumn = new Set(mappedColumns).size !== mappedColumns.length;
  const validAccount = accounts.some((account) => account.id === accountId);
  const mapping: CsvMapping | null =
    sample.data && !sample.isFetching && !sample.isError && !headersChanged
    && !repeatedColumn && columns.date !== null && amount && validAccount
      ? {
          headers: sample.data.headers,
          encoding: sample.data.encoding,
          delimiter: sample.data.delimiter,
          dateFormat,
          date: columns.date,
          amount,
          payee: columns.payee,
          note: columns.note,
          currency: columns.currency,
        }
      : null;

  const resetColumns = () => {
    setColumns(EMPTY_COLUMNS);
    setExpectedHeaders(null);
    setMessage("");
  };
  const columnField = (key: keyof Columns, label: string, required = false) => (
    <Field label={label}>
      {(id) => (
        <select id={id} name={`csv-column-${key}`} value={columns[key] ?? ""} onChange={(e) => {
          const value = e.target.value === "" ? null : Number(e.target.value);
          setColumns((old) => ({ ...old, [key]: value }));
        }}>
          <option value="">{required ? "Выберите столбец" : "Не использовать"}</option>
          {(headers ?? []).map((header, index) => (
            <option key={index} value={index}>{header && headers?.indexOf(header) === headers?.lastIndexOf(header) ? header : `Столбец ${index + 1}${header ? ` · ${header}` : ""}`}</option>
          ))}
        </select>
      )}
    </Field>
  );

  return (
    <section className="import-overview-preview" aria-label="Столбцы CSV" data-testid="csv-profile-editor">
      <div className="import-overview-heading">
        <h2>Столбцы CSV</h2>
        <p className="muted">Выберите счёт и укажите, какие данные брать из файла.</p>
      </div>
      <fieldset className="row import-bank" disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Профиль CSV">
          {(id) => (
            <select id={id} name="csvProfile" value={profileId} onChange={(e) => openProfile(e.target.value)}>
              <option value="">Новый профиль</option>
              {(profiles.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Разделитель">
          {(id) => (
            <select id={id} value={delimiter ?? ""} onChange={(e) => {
              setDelimiter((e.target.value || undefined) as CsvDelimiter | undefined);
              resetColumns();
            }}>
              <option value="">Автоматически</option>
              <option value="semicolon">Точка с запятой</option>
              <option value="comma">Запятая</option>
              <option value="tab">Табуляция</option>
            </select>
          )}
        </Field>
        <Field label="Кодировка">
          {(id) => (
            <select id={id} value={encoding ?? ""} onChange={(e) => {
              setEncoding((e.target.value || undefined) as CsvEncoding | undefined);
              resetColumns();
            }}>
              <option value="">Автоматически</option>
              <option value="utf8">UTF-8</option>
              <option value="windows1251">Windows-1251</option>
            </select>
          )}
        </Field>
      </fieldset>
      {sample.isFetching && <p className="muted" role="status">Читаем пример строк…</p>}
      {sample.error && <ErrorText error={String(sample.error)} />}
      {profiles.error && <ErrorText error={String(profiles.error)} />}
      {sample.data && (
        <div className="import-table" role="region" aria-label="Пример первых строк" tabIndex={0}>
          <table className="table">
            <thead><tr>{sample.data.headers.map((header, index) => <th key={index}>{header || `Столбец ${index + 1}`}</th>)}</tr></thead>
            <tbody>{sample.data.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {headersChanged && (
        <p className="warn" role="status">
          Заголовки файла отличаются от сохранённых в профиле.{" "}
          <button type="button" className="link" disabled={busy} onClick={resetColumns}>Сопоставить заново</button>
        </p>
      )}
      {sample.data && !headersChanged && (
        <fieldset className="row import-bank" disabled={busy || sample.isFetching} style={{ border: 0, padding: 0, margin: 0 }}>
          <Field label="Счёт">
            {(id) => <AccountSelect id={id} name="csvAccount" accounts={accounts} value={validAccount ? accountId : ""} onChange={setAccountId} />}
          </Field>
          {columnField("date", "Дата", true)}
          <Field label="Формат даты">
            {(id) => (
              <select id={id} value={dateFormat} onChange={(e) => setDateFormat(e.target.value as CsvDateFormat)}>
                <option value="standard">ДД.ММ.ГГГГ или ГГГГ-ММ-ДД</option>
                <option value="dayFirstSlash">ДД/ММ/ГГГГ</option>
                <option value="monthFirstSlash">ММ/ДД/ГГГГ</option>
              </select>
            )}
          </Field>
          <Field label="Сумма в файле">
            {(id) => (
              <select id={id} value={amountKind} onChange={(e) => setAmountKind(e.target.value as CsvMapping["amount"]["kind"])}>
                <option value="signed">Один столбец: минус — списание</option>
                <option value="debitCredit">Поступление и списание отдельно</option>
              </select>
            )}
          </Field>
          {amountKind === "signed" ? columnField("signed", "Сумма", true) : <>{columnField("debit", "Списание", true)}{columnField("credit", "Поступление", true)}</>}
          {columnField("payee", "Получатель")}
          {columnField("note", "Комментарий")}
          {columnField("currency", "Код валюты")}
        </fieldset>
      )}
      {repeatedColumn && <p className="warn" role="status">Выберите отдельный столбец для каждого поля.</p>}
      {!headersChanged && sample.data && <p className="hint">Проверьте знак, валюту и счёт. Переводы и возвраты в обычном CSV требуют отдельной проверки.</p>}
      {(saveProfile.error || deleteProfile.error) && <ErrorText error={String(saveProfile.error ?? deleteProfile.error)} />}
      {message && <p className="ok" role="status">{message}</p>}
      {sample.data && (
        <div className="row import-bank">
          <Field label="Название профиля">
            {(id) => <input id={id} name="csvProfileName" value={name} maxLength={60} disabled={busy} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <button type="button" className="btn" disabled={busy || !name.trim() || !mapping} onClick={() => mapping && saveProfile.mutate(mapping)}>
            {profileId ? "Обновить профиль" : "Сохранить профиль"}
          </button>
          {profileId && <button type="button" className="link" disabled={busy} onClick={() => deleteProfile.mutate(profileId)}>Удалить профиль</button>}
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Назад</button>
        <button type="button" className="btn primary" disabled={busy || !mapping} onClick={() => mapping && onPreview({ mapping, accountId })}>
          Проверить строки
        </button>
      </div>
    </section>
  );
}
