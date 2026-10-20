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
