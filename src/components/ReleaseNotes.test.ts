import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import changelog from "../../CHANGELOG.md?raw";
import { parseReleaseNotes } from "../lib/releaseNotes";
import { ReleaseNotes } from "./ReleaseNotes";

function render(text: string, version?: string) {
  return renderToStaticMarkup(createElement(ReleaseNotes, { text, version }));
}

describe("описания выпусков Kazna", () => {
  it("сохраняет все выпущенные версии реального журнала и скрывает внутреннюю приписку", () => {
    const published = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)\s*$/gm)].map(match => match[1]);
    const releases = parseReleaseNotes(changelog);
    expect(published).toContain("0.1.0");
    expect(releases.map(release => release.version)).toEqual(published);
    expect(releases.every(release => release.blocks.length > 0)).toBe(true);
    expect(JSON.stringify(releases)).not.toContain("Повторный CI ещё требуется");
  });

  it("распознаёт заголовок версии с подписью, группы, абзацы и многострочные пункты", () => {
    const lines = ["\uFEFF# Что нового", "## [Unreleased]", "- Черновик", "## Kazna v1.2.3 — Итоги месяца",
      "", "### Бюджет", "- Новый отчёт", "  о расходах", "* Гибкий период", "", "Можно открыть", "из бюджета."];
    expect(parseReleaseNotes(lines.join("\r\n"))).toEqual([{
      version: "1.2.3",
      blocks: [
        { kind: "paragraph", text: "Итоги месяца" }, { kind: "heading", text: "Бюджет" },
        { kind: "list", items: ["Новый отчёт о расходах", "Гибкий период"] },
        { kind: "paragraph", text: "Можно открыть из бюджета." },
      ],
    }]);
  });

  it("показывает установленную версию сразу, а архив оставляет за одним раскрытием", () => {
    const notes = "# Что нового\n## 1.2.0\n- Новый бюджет\n## 1.1.0\n- Календарь\n## 1.0.0\n- Счета";
    const html = render(notes, "1.1.0");
    expect(html).toContain("<h3>Версия 1.1.0</h3>");
    expect(html).toContain("<li>Календарь</li>");
    expect(html).toContain("<summary>Предыдущие версии</summary>");
    expect(html).not.toMatch(/<select|Что нового|Новый бюджет|Счета/);
    expect(render(notes)).toContain("<li>Новый бюджет</li>");
  });

  it("показывает текст обновления без повторного заголовка и только прежних инструкций скачивания", () => {
    const notes = ["# Что нового", "### Отчёты", "- **Итоги** доступны через `Ctrl+K`.",
      "", "Как установить лимит <script>?", "", "**Как установить:** скачайте `Kazna_1.2.3_x64-setup.exe` и запустите.",
      "", "**Без установки (флешка):** распакуйте `Kazna_1.2.3_x64-portable.zip`."].join("\n");
    const html = render(notes, "1.2.3");
    expect(html).toContain("<h4>Отчёты</h4>");
    expect(html).toContain("<li><strong>Итоги</strong> доступны через <code>Ctrl+K</code>.</li>");
    expect(html).toContain("Как установить лимит &lt;script&gt;?");
    expect(html).not.toMatch(/<script>|<h3>|Что нового|Предыдущие версии|setup\.exe|portable\.zip/);
  });

  it("даёт понятное пустое состояние без списка версий", () => {
    const html = render("  \n");
    expect(html).toContain("Для этой версии нет описания изменений.");
    expect(html).not.toContain("<details");
  });
});
