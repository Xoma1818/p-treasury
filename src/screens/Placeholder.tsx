import { SECTIONS, type SectionId } from "../lib/sections";

export function Placeholder({ id }: { id: SectionId }) {
  const s = SECTIONS.find((x) => x.id === id)!;
  return (
    <section className="screen">
      <h1>{s.title}</h1>
      <div className="card empty">Раздел появится на этапе {s.stage}.</div>
    </section>
  );
}
