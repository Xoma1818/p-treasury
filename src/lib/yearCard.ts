// Картинка «Итоги года» для того, чтобы поделиться: 1080×1350 (формат
// публикации в соцсетях и мессенджерах), в оформлении «Пульс».
// Рисуется на canvas без сети и без сторонних библиотек.
// С галочкой «Без сумм» вместо денег остаются только доли и проценты.

import type { YearReview } from "./api";
import { formatAmount } from "./money";
import { monthTitle } from "./dates";
import { brandMark } from "./brandMark";

const CARD_W = 1080;
const CARD_H = 1350;

const FONT = '"Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';
const DISPLAY_FONT = '"Segoe UI Variable Display", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';
const SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export interface CardOptions {
  symbol: string;
  minorUnits: number;
  /** Не показывать суммы: только проценты и доли. */
  hideAmounts: boolean;
}

function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Текст не шире `max`: лишнее — многоточием. */
function fit(g: CanvasRenderingContext2D, text: string, max: number) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

/** Тот же знак, что в меню. Рисуем синхронно перед сохранением PNG. */
function drawBrand(g: CanvasRenderingContext2D, x: number, y: number, height: number, plate: string, fold: string) {
  const mark = brandMark();
  const scale = height / mark.size;
  g.save();
  g.translate(x, y);
  g.scale(scale, scale);
  g.fillStyle = plate;
  g.fill(new Path2D(mark.plate));
  g.fillStyle = fold;
  g.fill(new Path2D(mark.fold));
  g.restore();
}

/** Нарисовать карточку года на `canvas` (размер выставляется сам). */
export function drawYearCard(canvas: HTMLCanvasElement, r: YearReview, o: CardOptions) {
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const g = canvas.getContext("2d")!;
  const style = getComputedStyle(canvas);
  const color = (name: string) => style.getPropertyValue("--" + name).trim();
  const C = {
    bg: color("bg"), card: color("card"), border: color("border"),
    text: color("text"), muted: color("muted"), accent: color("accent"), over: color("over"),
  };
  // На картинке копейки только мешают: суммы округляются до целых.
  const money = (v: number) => (o.hideAmounts ? "•••" : `${formatAmount(v, o.minorUnits, true, true)} ${o.symbol}`);
  const pad = 72;

  g.fillStyle = C.bg;
  g.fillRect(0, 0, CARD_W, CARD_H);
  // Мягкий свет выбранного акцента над верхним рядом.
  const glow = g.createRadialGradient(CARD_W - 120, 120, 20, CARD_W - 120, 120, 620);
  glow.addColorStop(0, C.accent);
  glow.addColorStop(1, "transparent");
  g.save();
  g.globalAlpha = .12;
  g.fillStyle = glow;
  g.fillRect(0, 0, CARD_W, CARD_H);
  g.restore();

  // Шапка.
  drawBrand(g, pad, 64, 64, color("palette-accent"), color("palette-on-accent"));
  g.save();
  g.font = `650 40px ${FONT}`;
  g.letterSpacing = "-3px";
  g.fillStyle = C.text;
  g.fillText("Kazna", pad + 80, 110);
  g.restore();
  g.textBaseline = "alphabetic";
  g.fillStyle = C.text;
  g.font = `700 76px ${DISPLAY_FONT}`;
  g.fillText(`Мой ${r.year} год`, pad, 236);
  g.fillStyle = C.muted;
  g.font = `400 30px ${FONT}`;
  const ops = `${r.transactionCount} ${plural(r.transactionCount, "операция", "операции", "операций")}`;
  g.fillText(`${ops} · ${r.days} ${plural(r.days, "день", "дня", "дней")} учёта`, pad, 286);

  // Три главные цифры.
  const saved = r.income - r.expense;
  const tiles: [string, string, string][] = [
    ["Заработали", money(r.income), C.text],
    ["Потратили", money(r.expense), C.text],
    ["Отложили", r.savingsRate != null ? `${r.savingsRate} %` : money(saved), C.accent],
  ];
  const tw = (CARD_W - pad * 2 - 2 * 24) / 3;
  tiles.forEach(([label, value, color], i) => {
    const x = pad + i * (tw + 24);
    g.fillStyle = C.card;
    roundRect(g, x, 336, tw, 168, 24);
    g.fill();
    g.fillStyle = C.muted;
    g.font = `400 26px ${FONT}`;
    g.fillText(label, x + 28, 386);
    g.fillStyle = color;
    let size = 46;
    g.font = `700 ${size}px ${FONT}`;
    while (size > 28 && g.measureText(value).width > tw - 56) g.font = `700 ${(size -= 2)}px ${FONT}`;
    g.fillText(value, x + 28, 462);
  });

  // Расходы по месяцам.
  const chartY = 560;
  const chartH = 300;
  g.fillStyle = C.card;
  roundRect(g, pad, chartY, CARD_W - pad * 2, chartH, 28);
  g.fill();
  g.fillStyle = C.muted;
  g.font = `400 26px ${FONT}`;
  g.fillText("Расходы по месяцам", pad + 28, chartY + 50);
  const months = Array.from({ length: 12 }, (_, i) => {
    const key = `${r.year}-${String(i + 1).padStart(2, "0")}`;
    return r.months.find((m) => m.period.month === key)?.expense ?? 0;
  });
  const max = Math.max(1, ...months);
  const slot = (CARD_W - pad * 2 - 56) / 12;
  const base = chartY + chartH - 56;
  const top = chartY + 80;
  months.forEach((v, i) => {
    const h = v > 0 ? Math.max(12, ((base - top) * v) / max) : 4;
    const x = pad + 28 + i * slot + slot * 0.2;
    const key = `${r.year}-${String(i + 1).padStart(2, "0")}`;
    g.fillStyle = key === r.costliestMonth ? C.over : v > 0 ? C.accent : C.border;
    roundRect(g, x, base - h, slot * 0.6, h, Math.min(10, h / 2, slot * 0.3));
    g.fill();
    g.fillStyle = C.muted;
    g.font = `400 20px ${FONT}`;
    g.textAlign = "center";
    g.fillText(SHORT[i], x + slot * 0.3, base + 34);
    g.textAlign = "left";
  });

  // Факты года.
  const facts: [string, string, string][] = [];
  const month = (m: string | null) => (m ? monthTitle(m).replace(/ \d{4}$/, "") : "");
  const top1 = r.topCategories[0];
  if (top1) facts.push(["Больше всего ушло на", top1.name, `${top1.percent} % расходов`]);
  if (r.bestMonth) {
    const b = r.months.find((m) => m.period.month === r.bestMonth);
    facts.push(["Лучший месяц", month(r.bestMonth), o.hideAmounts ? `отложено ${b?.savingsRate ?? 0} %` : `осталось ${money(b?.balance ?? 0)}`]);
  }
  if (r.topPayee) facts.push(["Чаще всего платили", r.topPayee.name, `${r.topPayee.count} ${plural(r.topPayee.count, "раз", "раза", "раз")}`]);
  // Без сумм крупная покупка ничего не говорит — вместо неё дни без трат.
  if (r.biggestPurchase && !o.hideAmounts)
    facts.push(["Самая крупная покупка", r.biggestPurchase.payee ?? r.biggestPurchase.categoryName ?? "Без названия", money(r.biggestPurchase.amount)]);
  facts.push(["Дни без трат", `${r.noSpendDays} ${plural(r.noSpendDays, "день", "дня", "дней")}`, `${r.days ? Math.round((r.noSpendDays / r.days) * 100) : 0} % дней года`]);
  const fw = (CARD_W - pad * 2 - 24) / 2;
  facts.slice(0, 4).forEach(([eyebrow, title, sub], i) => {
    const x = pad + (i % 2) * (fw + 24);
    const y = 900 + Math.floor(i / 2) * 170;
    g.fillStyle = C.card;
    roundRect(g, x, y, fw, 146, 24);
    g.fill();
    g.fillStyle = C.accent;
    roundRect(g, x, y + 28, 6, 90, 3);
    g.fill();
    g.fillStyle = C.muted;
    g.font = `400 22px ${FONT}`;
    g.fillText(eyebrow, x + 30, y + 44);
    g.fillStyle = C.text;
    g.font = `700 34px ${FONT}`;
    g.fillText(fit(g, title, fw - 56), x + 30, y + 90);
    g.fillStyle = C.muted;
    g.font = `400 24px ${FONT}`;
    g.fillText(fit(g, sub, fw - 56), x + 30, y + 124);
  });

  // Подвал.
  g.fillStyle = C.muted;
  g.font = `400 22px ${FONT}`;
  g.fillText("Личный бюджет в Kazna", pad, CARD_H - 52);
  g.textAlign = "right";
  g.fillText(r.year === new Date().getFullYear() ? "год ещё идёт" : `${r.year}`, CARD_W - pad, CARD_H - 52);
  g.textAlign = "left";
}

/** PNG карточки как байты — для сохранения в файл. */
export async function cardPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("не удалось собрать картинку"))), "image/png"));
}
