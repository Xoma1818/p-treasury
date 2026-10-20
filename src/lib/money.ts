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
  if (!m) return evalAmount(cleaned, minorUnits);
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

/** Есть ли в поле выражение (`1890+455`), а не просто число. */
export const isExpression = (input: string) => /\d\s*[+\-−*×/÷]\s*[\d(]|[()]/.test(input);

/**
 * Арифметика в поле суммы: числа, `+ − * /` и скобки. Считается точно
 * (дробями на BigInt), результат округляется до копейки от нуля.
 * Никакой код не выполняется: это маленький разборщик, не eval.
 */
export function evalAmount(input: string, minorUnits = 2): number | null {
  type Q = [bigint, bigint]; // числитель, знаменатель > 0
  const src = input.replace(/\s/g, "").replace(/−/g, "-").replace(/×/g, "*").replace(/÷/g, "/");
  if (!isExpression(src)) return null;
  let pos = 0;
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
  const norm = ([n, d]: Q): Q => {
    const g = gcd(n, d) || 1n;
    return [n / g, d / g];
  };
  const fail = (): never => {
    throw new Error("bad");
  };
  const number = (): Q => {
    const m = /^(\d+)(?:[.,](\d+))?/.exec(src.slice(pos)) ?? fail();
    pos += m[0].length;
    const frac = m[2] ?? "";
    return norm([BigInt(m[1] + frac), 10n ** BigInt(frac.length)]);
  };
  const factor = (): Q => {
    if (src[pos] === "-" || src[pos] === "+") {
      const neg = src[pos++] === "-";
      const [n, d] = factor();
      return [neg ? -n : n, d];
    }
    if (src[pos] === "(") {
      pos++;
      const v = expr();
      if (src[pos++] !== ")") fail();
      return v;
    }
    return number();
  };
  const term = (): Q => {
    let v = factor();
    while (src[pos] === "*" || src[pos] === "/") {
      const op = src[pos++];
      const [n, d] = factor();
      if (op === "/" && n === 0n) fail();
      v = op === "*" ? norm([v[0] * n, v[1] * d]) : norm(n < 0n ? [-v[0] * d, v[1] * -n] : [v[0] * d, v[1] * n]);
    }
    return v;
  };
  const expr = (): Q => {
    let v = term();
    while (src[pos] === "+" || src[pos] === "-") {
      const op = src[pos++];
      const [n, d] = term();
      v = norm([v[0] * d + (op === "+" ? n : -n) * v[1], v[1] * d]);
    }
    return v;
  };
  try {
    const [n, d] = expr();
    if (pos !== src.length) return null;
    const scaled = n * 10n ** BigInt(minorUnits);
    const abs = scaled < 0n ? -scaled : scaled;
    let q = abs / d;
    if ((abs % d) * 2n >= d) q += 1n;
    if (q > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return scaled < 0n ? -Number(q) : Number(q);
  } catch {
    return null;
  }
}
