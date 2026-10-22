/** Расчёты раздела «Инвестиции», которые живут только в интерфейсе (калькулятор). */

/** Общий лимит взносов на ИИС и ПДС для вычета: 400 000 ₽ в копейках (как в ядре). */
const TAX_LIMIT = 40_000_000;
const TAX_RATE = 0.13;

export interface GrowthInput {
  /** Уже вложено, в копейках. */
  start: number;
  /** Взнос в месяц, в копейках. */
  monthly: number;
  /** Ожидаемая доходность в год, % (может быть дробной: 12,5). */
  ratePct: number;
  years: number;
  /** Вычет ИИС раз в год возвращается и докладывается на счёт. */
  iis: boolean;
}

export interface GrowthRow {
  year: number;
  /** Вложено своих денег. */
  invested: number;
  /** Вычеты ИИС, вложенные обратно. */
  deductions: number;
  /** Стоимость на конец года. */
  value: number;
}

/**
 * Рост вложений с ежемесячным взносом: проценты начисляются каждый месяц по
 * ставке, равной годовой доходности; взнос — в конце месяца. Вычет считается
 * со взносов года в пределах лимита и докладывается в начале следующего года.
 */
export function projectGrowth({ start, monthly, ratePct, years, iis }: GrowthInput): GrowthRow[] {
  const r = Math.pow(1 + ratePct / 100, 1 / 12) - 1;
  let value = start;
  let invested = start;
  let deductions = 0;
  let pending = 0;
  const rows: GrowthRow[] = [];
  for (let y = 1; y <= Math.min(Math.max(years, 0), 50); y++) {
    value += pending;
    deductions += pending;
    for (let m = 0; m < 12; m++) value = value * (1 + r) + monthly;
    invested += monthly * 12;
    pending = iis ? Math.round(Math.min(monthly * 12, TAX_LIMIT) * TAX_RATE) : 0;
    rows.push({ year: y, invested, deductions, value: Math.round(value) });
  }
  return rows;
}

/** Десятые процента «67» → «6,7»; со знаком для результата. */
export function tenthsText(tenths: number, signed = false): string {
  const abs = Math.abs(tenths);
  const sign = tenths < 0 ? "−" : signed && tenths > 0 ? "+" : "";
  return `${sign}${Math.floor(abs / 10)},${abs % 10}`;
}

/** Сколько ещё отложить в этом месяце, чтобы выполнить план. */
export function leftToSave(planned: number | null, saved: number): number {
  return planned == null ? 0 : Math.max(planned - Math.max(saved, 0), 0);
}
