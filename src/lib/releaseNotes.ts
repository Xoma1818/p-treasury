type NoteBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] };

export type ReleaseNote = { version?: string; blocks: NoteBlock[] };

// Эти два абзаца прежний release.yml дописывал к заметкам на GitHub для ручного скачивания.
const OLD_DOWNLOAD_INSTRUCTION = /^\*\*(?:Как установить:\*\* скачайте `[^`]+_x64-setup\.exe`|Без установки \(флешка\):\*\* распакуйте `[^`]+_x64-portable\.zip`)/u;

function noteBlocks(lines: string[]): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let newParagraph = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || OLD_DOWNLOAD_INSTRUCTION.test(line)) {
      newParagraph = true;
      continue;
    }
    const item = /^[-*+]\s+(.+)/u.exec(line);
    const heading = /^#{1,6}\s+(.+)/u.exec(line);
    const last = blocks.at(-1);
    if (item) {
      if (last?.kind === "list") last.items.push(item[1]);
      else blocks.push({ kind: "list", items: [item[1]] });
    } else if (heading) {
      blocks.push({ kind: "heading", text: heading[1] });
    } else if (!newParagraph && last?.kind === "list") {
      last.items[last.items.length - 1] += ` ${line}`;
    } else if (!newParagraph && last?.kind === "paragraph") {
      last.text += ` ${line}`;
    } else {
      blocks.push({ kind: "paragraph", text: line });
    }
    newParagraph = false;
  }
  return blocks;
}

/** Локальный журнал содержит выпуски, а сервер присылает описание одной версии без шапки. */
export function parseReleaseNotes(source: string): ReleaseNote[] {
  const releases: ReleaseNote[] = [];
  let version: string | undefined;
  let draft = false;
  let lines: string[] = [];
  for (const line of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const heading = /^#{1,2}\s+(.+?)\s*$/u.exec(line.trim());
    if (heading) {
      if (/^Что нового$/iu.test(heading[1])) continue;
      const next = /^(?:(?:Kazna|Версия)\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=$|\s)(.*)$/iu.exec(heading[1]);
      const unpublished = /\(не выпущено\)|^\[?unreleased\]?$/iu.test(heading[1]);
      if (next || unpublished) {
        if (version && !draft) releases.push({ version, blocks: noteBlocks(lines) });
        version = next?.[1];
        draft = unpublished;
        const subtitle = next?.[2].replace(/^\s*[-–—:]?\s*/u, "");
        lines = subtitle ? [subtitle, ""] : [];
        continue;
      }
    }
    if (!draft) lines.push(line);
  }
  if (!draft) {
    const blocks = noteBlocks(lines);
    if (version || blocks.length) releases.push({ version, blocks });
  }
  return releases;
}
