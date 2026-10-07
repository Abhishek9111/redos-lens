"use client";

import { useState } from "react";
import { fmtMs, KILL_MS, type Sample } from "@/lib/redos/client";

const W = 560;
const H = 200;
const PAD = { l: 52, r: 16, t: 14, b: 34 };

/** Match time vs. attack-string length. Killed runs pin to the kill line. */
export function TimingChart({ samples }: { samples: Sample[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!samples.length) return null;

  const maxX = Math.max(...samples.map((s) => s.length));
  const maxY = Math.max(1, ...samples.map((s) => s.ms)) * 1.1;
  const killed = samples.some((s) => s.killed);
  const x = (v: number) => PAD.l + (v / maxX) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - (v / maxY) * (H - PAD.t - PAD.b);
  const ticks = niceTicks(maxY);
  const xTicks = niceTicks(maxX);
  const path = samples.map((s, i) => `${i ? "L" : "M"}${x(s.length)},${y(s.ms)}`).join("");
  const h = hover !== null ? samples[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label="Match time by input length"
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-3)">
              {fmtMs(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={H - PAD.b + 18} textAnchor="middle" fontSize={11} fill="var(--text-3)">
            {t.toLocaleString()}
          </text>
        ))}
        <text x={W - PAD.r} y={H - 4} textAnchor="end" fontSize={11} fill="var(--text-2)">
          input length (chars)
        </text>
        {killed && (
          <g>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(KILL_MS)}
              y2={y(KILL_MS)}
              stroke="var(--critical)"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
            <text x={PAD.l + 4} y={y(KILL_MS) - 5} fontSize={11} fill="var(--text-2)">
              ⨯ killed at {KILL_MS / 1000}s
            </text>
          </g>
        )}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        {h && (
          <line
            x1={x(h.length)}
            x2={x(h.length)}
            y1={PAD.t}
            y2={H - PAD.b}
            stroke="var(--text-3)"
            strokeWidth={1}
          />
        )}
        {samples.map((s, i) => (
          <g key={i}>
            <circle
              cx={x(s.length)}
              cy={y(s.ms)}
              r={s.killed ? 5 : 4}
              fill={s.killed ? "var(--critical)" : "var(--accent)"}
              stroke="var(--surface)"
              strokeWidth={2}
            />
            {/* Oversized hit target */}
            <rect
              x={x(s.length) - 12}
              y={PAD.t}
              width={24}
              height={H - PAD.t - PAD.b}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          </g>
        ))}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-sm"
          style={{
            left: `${(x(h.length) / W) * 100}%`,
            top: 0,
            transform: x(h.length) > W * 0.7 ? "translateX(calc(-100% - 8px))" : "translateX(8px)",
          }}
        >
          <div className="text-ink-2">{h.length.toLocaleString()} chars</div>
          <div className="font-medium text-ink">
            {h.killed ? `> ${fmtMs(KILL_MS)} (killed)` : fmtMs(h.ms)}
          </div>
        </div>
      )}
      <details className="mt-2 text-xs text-ink-2">
        <summary className="cursor-pointer select-none">Show as table</summary>
        <table className="mt-2 w-full font-mono">
          <thead>
            <tr className="text-left text-ink-3">
              <th className="font-normal">pumps</th>
              <th className="font-normal">length</th>
              <th className="text-right font-normal">time</th>
            </tr>
          </thead>
          <tbody>
            {samples.map((s, i) => (
              <tr key={i}>
                <td>{s.n.toLocaleString()}</td>
                <td>{s.length.toLocaleString()}</td>
                <td className="text-right">{s.killed ? `> ${fmtMs(KILL_MS)} killed` : fmtMs(s.ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function niceTicks(max: number): number[] {
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const s = max / step > 5 ? step * 2 : max / step > 2 ? step : step / 2;
  const out: number[] = [];
  for (let v = 0; v <= max; v += s) out.push(v);
  return out;
}
