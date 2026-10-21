import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { today } from "../lib/dates";
import { useSettings } from "../lib/queries";

/** Как часто, пока программа открыта, проверять, не пора ли обновить курсы. */
const CHECK_EVERY_MS = 60 * 60 * 1000;

/**
 * Курсы ЦБ РФ раз в день сами: при запуске и раз в час, пока программа открыта.
 * Без интернета молча пробует позже; выключается в Настройках → «Курсы валют».
 */
export function AutoRates() {
  const qc = useQueryClient();
  const enabled = useSettings().data?.rates_auto !== "0";
  useEffect(() => {
    if (!enabled) return;
    const check = () =>
      api
        .autoCbrRates(today())
        .then((r) => r && qc.invalidateQueries())
        .catch(() => {});
    check();
    const timer = setInterval(check, CHECK_EVERY_MS);
    return () => clearInterval(timer);
  }, [enabled, qc]);
  return null;
}
