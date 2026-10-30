"use client";

import { useEffect, useRef, useState } from "react";
import type { Analysis, Finding } from "./analyze";
import type { WorkerRequest, WorkerResponse } from "./worker";

/** A regex that doesn't finish within this budget is killed and counted as a hang. */
export const KILL_MS = 3000;
const ANALYSIS_TIMEOUT_MS = 2000;
/** A new worker has to download and start, which is slow in dev. */
const STARTUP_MS = 10_000;

function spawn() {
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

let nextId = 1;

export type AnalysisState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: Analysis }
  | { status: "timeout" }
  | { status: "error"; message: string };

/**
 * Debounced static analysis in a long-lived worker. If the analyzer itself
 * gets stuck, the worker is killed and replaced rather than freezing the tab.
 */
export function useAnalysis(source: string, flags: string): AnalysisState {
  const [state, setState] = useState<AnalysisState>({ status: "idle" });
  const workerRef = useRef<Worker | null>(null);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!source) return;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const id = nextId++;

    const debounce = setTimeout(() => {
      setState({ status: "running" });
      const fresh = workerRef.current === null;
      const worker = (workerRef.current ??= spawn());
      const kill = () => {
        clearTimeout(watchdog);
        worker.terminate();
        workerRef.current = null;
      };
      const fail = (message: string) => {
        kill();
        setState({ status: "error", message });
      };
      worker.onerror = (e) => fail(e.message || "The analysis worker failed to start.");
      worker.onmessageerror = () => fail("The analysis worker sent an unreadable reply.");
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        if (e.data.id !== id) return;
        if (e.data.kind === "error") fail(e.data.message);
        if (e.data.kind !== "analysis") return;
        clearTimeout(watchdog);
        setState({ status: "done", result: e.data.result });
      };
      watchdog = setTimeout(
        () => {
          kill();
          setState({ status: "timeout" });
        },
        fresh ? STARTUP_MS : ANALYSIS_TIMEOUT_MS,
      );
      worker.postMessage({ id, kind: "analyze", source, flags } satisfies WorkerRequest);
    }, 150);

    return () => {
      clearTimeout(debounce);
      clearTimeout(watchdog);
    };
  }, [source, flags]);

  return source ? state : { status: "idle" };
}

export interface Sample {
  n: number;
  length: number;
  ms: number;
  killed?: boolean;
}

export function sizesFor(f: Finding): number[] {
  if (f.severity === "exponential") {
    const out: number[] = [];
    for (let n = 4; n <= 48; n += 2) out.push(n);
    return out;
  }
  const out: number[] = [];
  for (let len = 256; len <= 1 << 20; len *= 2) out.push(Math.ceil(len / f.pump.length));
  return out;
}

/**
 * Time the full regex against growing attack strings in a throwaway worker.
 * Each run gets KILL_MS; a run that exceeds it is terminated and reported as killed.
 */
export function runTiming(
  source: string,
  flags: string,
  f: Finding,
  onSample: (s: Sample) => void,
  onDone: (error?: string) => void,
): () => void {
  const worker = spawn();
  const id = nextId++;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  const finish = (error?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    worker.terminate();
    onDone(error);
  };

  worker.onerror = (e) => finish(e.message || "The timing worker failed to start.");
  worker.onmessageerror = () => finish("The timing worker sent an unreadable reply.");
  watchdog = setTimeout(() => finish("The timing worker didn't start."), STARTUP_MS);

  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const m = e.data;
    if (m.id !== id) return;
    if (m.kind === "start") {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        onSample({ n: m.n, length: m.length, ms: KILL_MS, killed: true });
        finish();
      }, KILL_MS);
    } else if (m.kind === "sample") {
      clearTimeout(watchdog);
      onSample({ n: m.n, length: m.length, ms: m.ms });
    } else if (m.kind === "done") {
      finish();
    } else if (m.kind === "error") {
      finish(m.message);
    }
  };

  worker.postMessage({
    id,
    kind: "time",
    source,
    flags,
    prefix: f.prefix,
    pump: f.pump,
    suffix: f.suffix,
    sizes: sizesFor(f),
    budgetMs: 400,
  } satisfies WorkerRequest);

  return () => finish();
}

export interface Growth {
  confirmed: boolean;
  text: string;
}

function notReproduced(samples: Sample[]): Growth {
  const longest = samples[samples.length - 1]?.length ?? 0;
  return {
    confirmed: false,
    text: `Not reproduced: no slowdown up to ${longest.toLocaleString()} characters in this browser. Either this finding is a false alarm or this engine handles the pattern better than others, so test it in the engine you deploy on.`,
  };
}

/** Least-squares slope of y over x. */
function slope(points: [number, number][]): number {
  const mx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const my = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  const top = points.reduce((sum, p) => sum + (p[0] - mx) * (p[1] - my), 0);
  const bottom = points.reduce((sum, p) => sum + (p[0] - mx) ** 2, 0);
  return top / bottom;
}

/** Fit the measured growth and summarise it in words. Null while there's too little data. */
export function describeGrowth(f: Finding, samples: Sample[], running: boolean): Growth | null {
  const killed = samples.find((s) => s.killed);
  if (killed)
    return {
      confirmed: true,
      text: `Confirmed: a ${killed.length.toLocaleString()}-character input ran past ${KILL_MS / 1000}s and was killed.`,
    };

  const notYet = running ? null : notReproduced(samples);
  const usable = samples.filter((s) => s.ms >= 1).slice(-4);
  if (usable.length < 2) return notYet;
  const last = usable[usable.length - 1];

  if (f.severity === "exponential") {
    const perPump = Math.exp(slope(usable.map((s) => [s.n, Math.log(s.ms)])));
    if (perPump < 1.15) return notYet;
    const toTen = last.n + Math.log(10_000 / last.ms) / Math.log(perPump);
    const chars = Math.ceil(f.prefix.length + toTen * f.pump.length + f.suffix.length);
    return {
      confirmed: true,
      text: `Confirmed: each extra ${JSON.stringify(f.pump)} multiplies the time by about ×${perPump.toFixed(
        2,
      )}. Around ${chars} characters would block the thread for 10 s.`,
    };
  }

  const k = slope(usable.map((s) => [Math.log(s.length), Math.log(s.ms)]));
  if (k < 1.4) return notYet;
  const at = (len: number) => last.ms * Math.pow(len / last.length, k);
  return {
    confirmed: true,
    text: `Confirmed: measured growth is about O(n^${k.toFixed(1)}). Extrapolated, a 100 KB input takes ~${fmtMs(
      at(100_000),
    )} and 1 MB takes ~${fmtMs(at(1_000_000))}.`,
  };
}

export function fmtMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}
