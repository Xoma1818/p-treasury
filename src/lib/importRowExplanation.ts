import type { ImportRow } from "./api";

/** Объясняет результат предпросмотра. Решение о записи принимает ядро. */
export function importRowExplanation(row: ImportRow, bankStatement: boolean): string {
  if (row.error) return row.error;
  if (row.toTransfer) return "Существующая запись станет переводом между своими счетами.";

  const kind = row.type.toLowerCase();
  if (row.duplicate) {
    const pairedLine = bankStatement && kind === "перевод"
      ? /^вторая сторона строки (\d+)$/.exec(row.category)?.[1]
      : undefined;
    if (pairedLine) {
      return `Вторая сторона перевода из строки №${pairedLine}. Отдельную операцию не добавим.`;
    }
    return "Распознано как повтор. Отдельную операцию не добавим.";
  }
  if (row.linkedTo) return `Свяжем с вашей записью: ${row.linkedTo}.`;
  if (row.maybe > 0) {
    return `Возможные совпадения: ${row.maybe}. Выберите действие перед загрузкой.`;
  }
  if (kind === "возврат") return "Запишем как возврат покупки.";
  if (kind === "перевод") return "Запишем как перевод.";
  return "Добавим новую операцию.";
}
