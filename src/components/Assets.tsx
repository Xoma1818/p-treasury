import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Asset, type AssetKind } from "../lib/api";
import { formatDate, today } from "../lib/dates";
import { parseAmount } from "../lib/money";
import { useCurrencies, useSettings } from "../lib/queries";
import { useAction } from "../lib/useAction";
import { AmountInput, amountText, Field } from "./Fields";
import { ErrorText, Modal } from "./Modal";
import { Money } from "./Money";
import { Hint } from "./Hint";

const ASSET_KINDS: Record<AssetKind, string> = {
  realty: "Недвижимость",
  vehicle: "Транспорт",
  other: "Другое",
};

/** Имущество в «Счетах»: квартира, машина; оценка на дату входит в чистые активы. */
export function AssetsCard() {
  const assets = useQuery({ queryKey: ["assets"], queryFn: api.listAssets }).data ?? [];
  const [editing, setEditing] = useState<Asset | "new" | null>(null);
  return (
    <div className="card" data-testid="assets">
      <div className="screen-head">
        <h2>
          Имущество
          <Hint of="assets" />
        </h2>
        <button className="btn small" onClick={() => setEditing("new")}>
          + Имущество
        </button>
      </div>
      {assets.length === 0 ? (
        <p className="muted">Квартира, машина, дача: их оценка войдёт в чистые активы на Главной. На баланс счетов не влияет.</p>
      ) : (
        <table className="table">
          <tbody>
            {assets.map((a) => (
              <tr key={a.id} data-testid="asset-row" className="clickable" onClick={() => setEditing(a)}>
                <td>
                  <div className="main">{a.name}</div>
                  <div className="sub">
                    {ASSET_KINDS[a.kind]} · оценка на {formatDate(a.valuedOn)}
                    {a.history.length > 1 && <AssetTrend asset={a} />}
                  </div>
                </td>
                <td className="num">
                  <Money amount={a.value} symbol={a.currencySymbol} minorUnits={a.minorUnits} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <AssetForm asset={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** «· +12 % с 10.01.2026» — изменение с первой оценки. */
function AssetTrend({ asset }: { asset: Asset }) {
  const first = asset.history[asset.history.length - 1];
  if (!first.value) return null;
  const pct = Math.round(((asset.value - first.value) / first.value) * 100);
  return (
    <span data-testid="asset-trend">
      {" "}
      · {pct >= 0 ? "+" : "−"}
      {Math.abs(pct)} % с {formatDate(first.date)}
    </span>
  );
}

function AssetForm({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const currencies = useCurrencies().data ?? [];
  const base = useSettings().data?.base_currency ?? "RUB";
  const [name, setName] = useState(asset?.name ?? "");
  const [kind, setKind] = useState<AssetKind>(asset?.kind ?? "realty");
  const [currencyCode, setCurrency] = useState(asset?.currencyCode ?? base);
  const minor = currencies.find((c) => c.code === currencyCode)?.minorUnits ?? 2;
  const [value, setValue] = useState(amountText(asset?.value ?? null, asset?.minorUnits));
  const [date, setDate] = useState(today());
  const [note, setNote] = useState(asset?.note ?? "");
  const save = useAction(
    (v: number) => {
      const input = { name, kind, currencyCode, value: v, date, note: note || null };
      return asset ? api.updateAsset(asset.id, input) : api.createAsset(input);
    },
    onClose,
    { celebrate: true },
  );
  const remove = useAction(() => api.deleteAsset(asset!.id), onClose);
  const submit = () => {
    const v = parseAmount(value, minor);
    if (v === null || v < 0) return save.setError("Введите оценку стоимости");
    save.run(v);
  };

  return (
    <Modal title={asset ? asset.name : "Новое имущество"} onClose={onClose}>
      <form className="form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <Field label="Название">
          {(id) => <input id={id} name="assetName" placeholder="Например, «Квартира»" value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <div className="row">
          <Field label="Вид">
            {(id) => (
              <select id={id} name="assetKind" value={kind} onChange={(e) => setKind(e.target.value as AssetKind)}>
                {Object.entries(ASSET_KINDS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Валюта">
            {(id) => (
              <select id={id} name="assetCurrency" value={currencyCode} onChange={(e) => setCurrency(e.target.value)}>
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <div className="row">
          <Field label={asset ? "Новая оценка" : "Стоимость"} hint="Сколько можно выручить сейчас, примерно.">
            {(id) => <AmountInput id={id} name="assetValue" value={value} onChange={setValue} minorUnits={minor} />}
          </Field>
          <Field label="На дату">{(id) => <input id={id} name="assetDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        <Field label="Комментарий">{(id) => <input id={id} name="assetNote" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {asset && asset.history.length > 1 && (
          <div className="asset-history" data-testid="asset-history">
            <div className="muted">Прошлые оценки</div>
            <ul>
              {asset.history.map((h) => (
                <li key={h.date}>
                  {formatDate(h.date)} — <Money amount={h.value} symbol={asset.currencySymbol} minorUnits={asset.minorUnits} />
                </li>
              ))}
            </ul>
          </div>
        )}
        <ErrorText error={save.error ?? remove.error} />
        <div className="actions">
          {asset && (
            <button type="button" className="btn danger" onClick={() => remove.run()} disabled={remove.busy}>
              Удалить
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" aria-busy={save.busy} data-done={save.done || undefined} disabled={save.busy}>
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}
