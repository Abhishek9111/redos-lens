import type { Finding } from "@/lib/redos/analyze";

/** The pattern source with the active finding's spans highlighted. */
export function PatternView({
  source,
  flags,
  finding,
}: {
  source: string;
  flags: string;
  finding: Finding | null;
}) {
  // Character-level marks: 1 = primary span (the loop), 2 = secondary (alternatives).
  const marks = new Uint8Array(source.length);
  finding?.spans.forEach((s, i) => {
    for (let k = s.start; k < s.end; k++) marks[k] = Math.max(marks[k], i === 0 ? 1 : 2);
  });

  const runs: { text: string; mark: number }[] = [];
  for (let i = 0; i < source.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.mark === marks[i]) last.text += source[i];
    else runs.push({ text: source[i], mark: marks[i] });
  }

  return (
    <code className="block overflow-x-auto whitespace-pre rounded-lg border border-line bg-surface-2 px-3 py-2.5 font-mono text-[15px] leading-relaxed">
      <span className="text-ink-3">/</span>
      {runs.map((r, i) => (
        <span
          key={i}
          style={
            r.mark === 1
              ? { background: "var(--hl)", boxShadow: "inset 0 -2px var(--critical)" }
              : r.mark === 2
                ? { background: "var(--hl-2)" }
                : undefined
          }
        >
          {r.text}
        </span>
      ))}
      <span className="text-ink-3">/{flags}</span>
    </code>
  );
}
