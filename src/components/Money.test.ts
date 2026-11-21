import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { notifyFine } from "../lib/fine";
import { Money } from "./Money";

it("не раскрывает сумму до загрузки настройки и показывает её только в открытом режиме", () => {
  const client = new QueryClient();
  const render = () => renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(Money, { amount: 12345, symbol: "₽" })));
  expect(render()).toContain("•••");
  for (const hide_amounts of ["1", "0"]) {
    client.setQueryData(["settings"], { settings: { hide_amounts }, prefsRevision: 0 });
    const html = render();
    if (hide_amounts === "1") expect(html).not.toMatch(/123|₽/);
    else expect(html).toContain("123,45");
  }
  client.clear();
});

it("показывает точный код валют с общим знаком ¥", () => {
  const client = new QueryClient();
  client.setQueryData(["settings"], { settings: { hide_amounts: "0" }, prefsRevision: 0 });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", { getItem: () => '{"code":true}' });
  try {
    notifyFine();
    for (const [currencyCode, minorUnits] of [["JPY", 0], ["CNY", 2]] as const) {
      const html = renderToStaticMarkup(createElement(QueryClientProvider, { client },
        createElement(Money, { amount: 12000, symbol: "¥", currencyCode, minorUnits })));
      expect(html).toContain(currencyCode === "JPY" ? "12 000 JPY" : "120 CNY");
    }
  } finally {
    vi.stubGlobal("localStorage", { getItem: () => null });
    notifyFine();
    vi.unstubAllGlobals();
    client.clear();
  }
});
