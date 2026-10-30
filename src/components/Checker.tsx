"use client";

import { useState } from "react";
import { useAnalysis } from "@/lib/redos/client";
import { parseInput } from "@/lib/redos/format";
import { FindingCard } from "./FindingCard";
import { PatternView } from "./PatternView";

const EXAMPLES: { label: string; source: string; flags?: string }[] = [
  { label: "Nested quantifier", source: "^(a+)+$" },
  { label: "Word list", source: "^(\\w+\\s?)*$" },
  { label: "Trailing whitespace", source: "\\s+$" },
  {
    label: "Classic email",
    source: "^([a-zA-Z0-9_\\.\\-])+\\@(([a-zA-Z0-9\\-])+\\.)+([a-zA-Z0-9]{2,4})+$",
  },
  { label: "Overlapping classes", source: "^(\\d|\\w)+$" },
  { label: "Safe slug", source: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
];

const VERDICT = {
  exponential: {
    icon: "▲",
    color: "var(--critical)",
    title: "Vulnerable: exponential backtracking",
    body: "A short crafted input (a few dozen characters) can block the event loop for seconds or more.",
  },
  polynomial: {
    icon: "◆",
    color: "var(--serious)",
    title: "Vulnerable: polynomial backtracking",
    body: "Match time grows super-linearly with input length. Dangerous on unbounded input, so cap the length or rewrite.",
  },
  possible: {
    icon: "◇",
    color: "var(--warning)",
    title: "Possible ReDoS, not confirmed",
    body: "A risky loop was found, but the generated input couldn't reach it. Check whether a real input could.",
  },
  safe: {
    icon: "●",
    color: "var(--good)",
    title: "No ReDoS pattern found",
    body: "No ambiguous loop that can be forced to backtrack was found.",
  },
  invalid: { icon: "■", color: "var(--text-3)", title: "Invalid regex", body: "" },
} as const;

export function Checker() {
  const [source, setSource] = useState(EXAMPLES[0].source);
  const [flags, setFlags] = useState("");
  const [selected, setSelected] = useState(0);
  const state = useAnalysis(source, flags);

  const onPattern = (value: string) => {
    setSource(value);
    setSelected(0);
  };

  // Pasting over the whole field accepts a /pattern/flags literal. Typing never
  // does, so a pattern that really starts and ends with a slash stays intact.
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const lit = parseInput(e.clipboardData.getData("text"));
    if (!lit || el.selectionStart !== 0 || el.selectionEnd !== el.value.length) return;
    e.preventDefault();
    setSource(lit.source);
    setFlags(lit.flags);
    setSelected(0);
  };

  // Ignore a result for text that has since changed: its spans no longer line up.
  const result =
    state.status === "done" && state.result.source === source && state.result.flags === flags
      ? state.result
      : null;
  const findings = result?.findings ?? [];
  const v = result ? VERDICT[result.verdict] : null;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <label className="block text-sm font-medium text-ink-2" htmlFor="pattern">
          Regular expression
        </label>
        <div className="flex items-stretch overflow-hidden rounded-xl border border-line bg-surface font-mono text-[15px] focus-within:border-ink-3">
          <span className="flex items-center pl-3 text-ink-3">/</span>
          <input
            id="pattern"
            value={source}
            onChange={(e) => onPattern(e.target.value)}
            onPaste={onPaste}
            spellCheck={false}
            autoComplete="off"
            placeholder="paste a pattern or /pattern/flags"
            className="min-w-0 flex-1 bg-transparent px-1 py-3 outline-none"
          />
          <span className="flex items-center text-ink-3">/</span>
          <input
            aria-label="Flags"
            value={flags}
            onChange={(e) => {
              setFlags(e.target.value.replace(/[^dgimsuvy]/g, ""));
              setSelected(0);
            }}
            spellCheck={false}
            placeholder="flags"
            className="w-16 bg-transparent py-3 pr-3 pl-1 outline-none"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              onClick={() => {
                setSource(ex.source);
                setFlags(ex.flags ?? "");
                setSelected(0);
              }}
              className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-2 hover:border-ink-3 hover:text-ink"
            >
              {ex.label}
            </button>
          ))}
        </div>
      </section>

      {state.status === "timeout" && (
        <Banner icon="▲" color="var(--critical)" title="Analysis timed out">
          The analyzer&apos;s worker was killed after 2 s. That almost always means the pattern
          backtracks catastrophically even on tiny inputs.
        </Banner>
      )}

      {state.status === "error" && (
        <Banner icon="■" color="var(--text-3)" title="Analysis failed">
          The checker hit an internal error, so this says nothing about your pattern:{" "}
          {state.message}
        </Banner>
      )}

      {result && v && (
        <Banner icon={v.icon} color={v.color} title={v.title}>
          {result.error ?? v.body}
        </Banner>
      )}

      {result && !result.error && (
        <PatternView source={source} flags={flags} finding={findings[selected] ?? null} />
      )}

      {findings.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-ink-2">
            {findings.length} finding{findings.length > 1 ? "s" : ""}
          </h2>
          {findings.map((f, i) => (
            <FindingCard
              key={`${source}/${flags}/${i}`}
              finding={f}
              source={source}
              flags={flags}
              active={i === selected}
              onSelect={() => setSelected(i)}
            />
          ))}
        </section>
      )}

      {result?.notes.map((n) => (
        <p key={n} className="text-sm text-ink-3">
          {n}
        </p>
      ))}
    </div>
  );
}

function Banner({
  icon,
  color,
  title,
  children,
}: {
  icon: string;
  color: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex gap-3 rounded-xl border p-4"
      style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 7%, var(--surface))` }}
    >
      <span aria-hidden style={{ color }} className="mt-0.5">
        {icon}
      </span>
      <div>
        <div className="font-medium">{title}</div>
        {children && <div className="mt-0.5 text-sm text-ink-2">{children}</div>}
      </div>
    </div>
  );
}
