"use client";

import { useEffect, useRef, useState } from "react";
import type { Finding } from "@/lib/redos/analyze";
import { describeGrowth, runTiming, type Sample } from "@/lib/redos/client";
import { TimingChart } from "./TimingChart";

export function FindingCard({
  finding: f,
  source,
  flags,
  active,
  onSelect,
}: {
  finding: Finding;
  source: string;
  flags: string;
  active: boolean;
  onSelect: () => void;
}) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cancelRef.current?.(), []);

  const measure = () => {
    cancelRef.current?.();
    setSamples([]);
    setRunning(true);
    cancelRef.current = runTiming(
      source,
      flags,
      f,
      (s) => setSamples((prev) => [...prev, s]),
      () => setRunning(false),
    );
  };

  const n = f.severity === "exponential" ? 30 : 50_000;
  const snippet =
    `/${source}/${flags.replace("g", "")}.test(` +
    [JSON.stringify(f.prefix), `${JSON.stringify(f.pump)}.repeat(${n})`, JSON.stringify(f.suffix)]
      .filter((p) => p !== '""')
      .join(" + ") +
    ")";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const badge =
    f.severity === "exponential"
      ? { label: "Exponential", color: "var(--critical)", icon: "▲" }
      : { label: `Polynomial · O(n${sup(f.degree ?? 2)})`, color: "var(--serious)", icon: "◆" };

  const growth = describeGrowth(f, samples, running);

  return (
    <article
      onClick={onSelect}
      className={`rounded-xl border bg-surface p-4 transition-colors ${
        active ? "border-ink-3" : "border-line hover:border-ink-3/50"
      } ${f.exploitable ? "" : "opacity-70"}`}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
          style={{ color: badge.color, background: `color-mix(in srgb, ${badge.color} 12%, transparent)` }}
        >
          <span aria-hidden>{badge.icon}</span>
          {badge.label}
        </span>
        <h3 className="font-medium">{f.title}</h3>
        {!f.exploitable && (
          <span className="text-xs text-ink-3">not exploitable: the match always succeeds</span>
        )}
      </header>

      <p className="mt-2 text-sm leading-relaxed text-ink-2">
        <Inline text={f.detail} />
      </p>

      <div className="mt-3 rounded-lg bg-surface-2 p-3">
        <div className="mb-1 text-xs text-ink-3">Attack input</div>
        <code className="block break-all font-mono text-[13px]">
          {f.prefix && <span>{JSON.stringify(f.prefix)} + </span>}
          <span className="text-critical">{JSON.stringify(f.pump)}</span>
          <span className="text-ink-3"> × n</span>
          {f.suffix && <span> + {JSON.stringify(f.suffix)}</span>}
        </code>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            measure();
          }}
          disabled={running}
          className="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-60"
        >
          {running ? "Measuring…" : samples.length ? "Measure again" : "Measure in sandbox"}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            copy();
          }}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:text-ink"
        >
          {copied ? "Copied" : "Copy repro"}
        </button>
      </div>

      {samples.length > 0 && (
        <div className="mt-4">
          <TimingChart samples={samples} />
          {growth && (
            <p className="mt-2 flex gap-2 text-sm text-ink-2">
              <span aria-hidden style={{ color: growth.confirmed ? "var(--critical)" : "var(--text-3)" }}>
                {growth.confirmed ? "▲" : "○"}
              </span>
              <span>{growth.text}</span>
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/** Render `code` spans from the analyzer's backtick-delimited text. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]*`)/).map((part, i) =>
        part.startsWith("`") ? (
          <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[0.9em] text-ink">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

function sup(n: number) {
  return String(n).replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)]);
}
