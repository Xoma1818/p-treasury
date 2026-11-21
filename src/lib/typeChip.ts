import { TXN_TYPES, type TxnType } from "./api";

/** Подпись плашки «Тип» в Операциях: все выбранные типы, а не только первый
 *  («Сальдо» открывает доходы и расходы сразу). */
export function typeChipLabel(types: TxnType[], counted?: boolean): string {
  const label = types.map((t, i) => (i === 0 ? TXN_TYPES[t] : TXN_TYPES[t].toLowerCase())).join(" и ");
  return counted && types.includes("expense") ? `${label} с возвратами` : label;
}
