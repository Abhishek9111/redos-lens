import { analyze, type Analysis } from "./analyze";

export type WorkerRequest =
  | { id: number; kind: "analyze"; source: string; flags: string }
  | {
      id: number;
      kind: "time";
      source: string;
      flags: string;
      prefix: string;
      pump: string;
      suffix: string;
      sizes: number[];
      budgetMs: number;
    };

export type WorkerResponse =
  | { id: number; kind: "analysis"; result: Analysis }
  | { id: number; kind: "start"; n: number; length: number }
  | { id: number; kind: "sample"; n: number; length: number; ms: number }
  | { id: number; kind: "done" }
  | { id: number; kind: "error"; message: string };

const post = (m: WorkerResponse) =>
  (self as unknown as { postMessage(m: WorkerResponse): void }).postMessage(m);

function handle(m: WorkerRequest) {
  if (m.kind === "analyze") {
    post({ id: m.id, kind: "analysis", result: analyze(m.source, m.flags) });
    return;
  }

  const re = new RegExp(m.source, m.flags.replace("g", ""));
  for (const n of m.sizes) {
    const input = m.prefix + m.pump.repeat(n) + m.suffix;
    // Announce before running so the main thread can attribute a hang to this n.
    post({ id: m.id, kind: "start", n, length: input.length });
    re.lastIndex = 0;
    const t0 = performance.now();
    re.test(input);
    const ms = performance.now() - t0;
    post({ id: m.id, kind: "sample", n, length: input.length, ms });
    if (ms > m.budgetMs) break;
  }
  post({ id: m.id, kind: "done" });
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  try {
    handle(e.data);
  } catch (err) {
    post({ id: e.data.id, kind: "error", message: (err as Error).message });
  }
};
