import { useMemo, useState } from "react";
import { parseReleaseNotes, type ReleaseNote } from "../lib/releaseNotes";
import "./releaseNotes.css";

function formatted(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/gu).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function NoteBody({ blocks }: Pick<ReleaseNote, "blocks">) {
  if (!blocks.length) return <p className="muted">Для этой версии нет описания изменений.</p>;
  return (
    <div className="release-notes-body">
      {blocks.map((block, index) => {
        if (block.kind === "heading") return <h4 key={index}>{formatted(block.text)}</h4>;
        if (block.kind === "paragraph") return <p key={index}>{formatted(block.text)}</p>;
        return <ul key={index}>{block.items.map((item, i) => <li key={i}>{formatted(item)}</li>)}</ul>;
      })}
    </div>
  );
}

export function ReleaseNotes({ text, version }: { text: string; version?: string }) {
  const releases = useMemo(() => parseReleaseNotes(text), [text]);
  const current = releases.find(release => release.version === version) ?? releases[0];
  const archive = releases.filter(release => release !== current);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const previous = archive.find(release => release.version === selected) ?? archive[0];
  return (
    <div className="release-notes">
      {current?.version && <h3>Версия {current.version}</h3>}
      <NoteBody blocks={current?.blocks ?? []} />
      {previous && (
        <details className="release-notes-archive" onToggle={e => setOpen(e.currentTarget.open)}>
          <summary>Предыдущие версии</summary>
          {open && <>
            <label className="release-notes-picker">
              <span>Версия</span>
              <select value={previous.version} onChange={e => setSelected(e.target.value)}>
                {archive.map(release => <option key={release.version} value={release.version}>{release.version}</option>)}
              </select>
            </label>
            <NoteBody blocks={previous.blocks} />
          </>}
        </details>
      )}
    </div>
  );
}
