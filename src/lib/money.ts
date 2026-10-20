// Деньги в UI: целые минимальные единицы (копейки), как в ядре.
// Формат совпадает с budget_core::money::format_amount.

const GROUP_SEP = " ";

export function formatAmount(amount: number, minorUnits = 2, trimZeroFraction = true): string {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`сумма должна быть целым числом минимальных единиц: ${amount}`);
  }
  const negative = amount < 0;
  const abs = BigInt(Math.abs(amount));
  const scale = 10n ** BigInt(minorUnits);
  const intPart = (abs / scale).toString();
  const fracPart = abs % scale;

  let grouped = "";
  for (let i = 0; i < intPart.length; i++) {
    if (i > 0 && (intPart.length - i) % 3 === 0) grouped += GROUP_SEP;
    grouped += intPart[i];
  }

  let out = (negative ? "−" : "") + grouped;
  if (minorUnits > 0 && !(trimZeroFraction && fracPart === 0n)) {
    out += "," + fracPart.toString().padStart(minorUnits, "0");
  }
  return out;
}

export function formatMoney(amount: number, symbol: string, minorUnits = 2): string {
  return `${formatAmount(amount, minorUnits)}${GROUP_SEP}${symbol}`;
}

export const HIDDEN_AMOUNT = "•••";

/**
 * Разобрать сумму, введённую пользователем, в минимальные единицы.
 * Правила совпадают с budget_core::money::parse_amount. `null` — ошибка ввода.
 */
export function parseAmount(input: string, minorUnits = 2): number | null {
  const cleaned = input.replace(/[\s  ]/g, "");
  const m = /^([+\-−]?)(\d*)(?:[.,](\d*))?$/.exec(cleaned);
  if (!m) return null;
  const [, sign, intPart, fracPart = ""] = m;
  if ((intPart === "" && fracPart === "") || fracPart.length > minorUnits) return null;
  const value = BigInt(intPart || "0") * 10n ** BigInt(minorUnits) + BigInt((fracPart || "0").padEnd(minorUnits, "0"));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const n = Number(value);
  return sign === "-" || sign === "−" ? -n : n;
}

/** Сумма для поля ввода: «1234,5» без разделителей разрядов. */
export function amountToInput(amount: number, minorUnits = 2): string {
  return formatAmount(amount, minorUnits).replace(/ /g, "").replace("−", "-");
}
