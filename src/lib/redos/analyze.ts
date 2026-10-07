import { RegExpParser, type AST } from "@eslint-community/regexpp";

/**
 * Static ReDoS analysis for JavaScript (backtracking) regexes.
 *
 * Approach: walk the AST and, for every unbounded loop, search for a short
 * "pump" string that the loop can consume in more than one way. Instead of
 * building an NFA by hand, ambiguity is tested by compiling small sub-patterns
 * with the real engine against a reduced probe alphabet — on 1–4 character
 * strings, which is always fast.
 *
 *  - Exponential (EDA): loop body B matches both w and ww, or two
 *    alternatives of B both match w. Then B* has exponentially many ways to
 *    split wⁿ.
 *  - Polynomial (IDA): k loops in sequence (only nullable stuff between them)
 *    that can all consume the same character. Unanchored patterns get an
 *    implicit leading loop, because the engine retries at every offset.
 *
 * A finding is only "exploitable" if some suffix makes the overall match
 * fail — otherwise the engine returns on the first path and never backtracks.
 */

export type Severity = "exponential" | "polynomial";

export interface Finding {
  severity: Severity;
  /** For polynomial findings: the k in O(nᵏ). */
  degree?: number;
  rule: "nested-quantifier" | "overlapping-alternation" | "adjacent-quantifiers";
  title: string;
  detail: string;
  /** Source ranges in the pattern to highlight. */
  spans: { start: number; end: number }[];
  prefix: string;
  pump: string;
  suffix: string;
  /** Whether a failing suffix was found (i.e. backtracking is actually forced). */
  exploitable: boolean;
}

export interface Analysis {
  source: string;
  flags: string;
  error?: string;
  verdict: "safe" | "polynomial" | "exponential" | "invalid";
  findings: Finding[];
  notes: string[];
}

type Quantifier = AST.Quantifier;
type Node = AST.Node;

const PROBE: string[] = (() => {
  const out: string[] = [];
  const push = (from: number, to: number) => {
    for (let c = from; c <= to; c++) out.push(String.fromCharCode(c));
  };
  push(97, 122); // a-z
  push(65, 90); // A-Z
  push(48, 57); // 0-9
  push(32, 47);
  push(58, 64);
  push(91, 96);
  push(123, 126);
  push(0, 31);
  out.push("\x7f", "é", "ß", "İ", " ", " ", "€", "中");
  return out;
})();

const LOOP_THRESHOLD = 10; // {n,m} with m ≥ this is treated as a loop
const MAX_REPS = 16;

export function analyze(source: string, flags: string): Analysis {
  const base: Analysis = { source, flags, verdict: "safe", findings: [], notes: [] };

  let full: RegExp;
  try {
    full = new RegExp(source, flags.replace("g", ""));
  } catch (e) {
    return { ...base, verdict: "invalid", error: (e as Error).message };
  }

  let pattern: AST.Pattern;
  try {
    pattern = new RegExpParser().parsePattern(source, 0, source.length, {
      unicode: flags.includes("u"),
      unicodeSets: flags.includes("v"),
    });
  } catch (e) {
    return { ...base, verdict: "invalid", error: (e as Error).message };
  }

  const ctx = new Context(pattern, flags, full);
  const findings: Finding[] = [];

  for (const q of ctx.loops) findings.push(...ctx.checkExponential(q));
  const expSpans = findings.flatMap((f) => f.spans.slice(0, 1));
  for (const alt of ctx.alternatives) {
    const f = ctx.checkPolynomial(alt);
    // Skip polynomial findings that are just a symptom of an exponential loop.
    const covered = f?.spans.every((s) =>
      expSpans.some((e) => e.start <= s.start && s.end <= e.end),
    );
    if (f && !covered) findings.push(f);
  }

  if (ctx.hasBackref) {
    base.notes.push(
      "Pattern uses backreferences. These aren't regular, so loops containing them are only approximated.",
    );
  }
  if (ctx.compileFailures > 0) {
    base.notes.push(
      `${ctx.compileFailures} sub-pattern(s) couldn't be compiled in isolation and were approximated.`,
    );
  }

  findings.sort(
    (a, b) =>
      Number(b.exploitable) - Number(a.exploitable) ||
      rank(b) - rank(a),
  );

  const live = findings.filter((f) => f.exploitable);
  const verdict = live.some((f) => f.severity === "exponential")
    ? "exponential"
    : live.length
      ? "polynomial"
      : "safe";

  if (verdict === "safe" && findings.length) {
    base.notes.push(
      "Ambiguous loops were found, but no input forced the overall match to fail, so the engine never backtracks through them.",
    );
  }

  return { ...base, verdict, findings };
}

function rank(f: Finding) {
  return f.severity === "exponential" ? 100 : (f.degree ?? 2);
}

class Context {
  loops: Quantifier[] = [];
  alternatives: AST.Alternative[] = [];
  hasBackref = false;
  compileFailures = 0;

  private leafSets = new Map<Node, Set<string>>();
  private reps: string[];
  private testFlags: string;
  private reCache = new Map<string, RegExp | null>();
  private charsCache = new Map<Node, Set<string>>();

  constructor(
    private pattern: AST.Pattern,
    private flags: string,
    private full: RegExp,
  ) {
    // Flags that don't change what a sub-pattern matches in isolation.
    this.testFlags = [...flags].filter((f) => "isuv".includes(f)).join("");
    this.walk(pattern);
    this.reps = this.representatives();
  }

  // ---------- setup ----------

  private walk(node: Node) {
    switch (node.type) {
      case "Pattern":
      case "Group":
      case "CapturingGroup":
        node.alternatives.forEach((a) => this.walk(a));
        break;
      case "Assertion":
        if (node.kind === "lookahead" || node.kind === "lookbehind")
          node.alternatives.forEach((a) => this.walk(a));
        break;
      case "Alternative":
        this.alternatives.push(node);
        node.elements.forEach((e) => this.walk(e));
        break;
      case "Quantifier":
        if (node.max >= LOOP_THRESHOLD) this.loops.push(node);
        this.walk(node.element);
        break;
      case "Backreference":
        this.hasBackref = true;
        break;
      case "Character":
      case "CharacterSet":
      case "CharacterClass":
      case "ExpressionCharacterClass":
        this.leafSets.set(node, this.probeLeaf(node));
        break;
    }
  }

  private probeLeaf(node: Node): Set<string> {
    const re = this.compile(node.raw);
    if (!re) return new Set(PROBE);
    return new Set(PROBE.filter((c) => re.test(c)));
  }

  /** One probe character per distinct "which leaves match me" signature. */
  private representatives(): string[] {
    const leaves = [...this.leafSets.values()];
    const seen = new Map<string, string>();
    for (const c of PROBE) {
      const sig = leaves.map((s) => (s.has(c) ? "1" : "0")).join("");
      if (!seen.has(sig)) seen.set(sig, c);
    }
    return [...seen.values()];
  }

  /** Compile `body` anchored at both ends, or null if it can't stand alone. */
  private compile(body: string): RegExp | null {
    if (this.reCache.has(body)) return this.reCache.get(body)!;
    let re: RegExp | null = null;
    try {
      re = new RegExp(`^(?:${body})$`, this.testFlags);
    } catch {
      this.compileFailures++;
    }
    this.reCache.set(body, re);
    return re;
  }

  // ---------- node helpers ----------

  private containsBackref(node: Node): boolean {
    switch (node.type) {
      case "Backreference":
        return true;
      case "Quantifier":
        return this.containsBackref(node.element);
      case "Alternative":
        return node.elements.some((e) => this.containsBackref(e));
      case "Group":
      case "CapturingGroup":
      case "Pattern":
        return node.alternatives.some((a) => this.containsBackref(a));
      case "Assertion":
        return (
          (node.kind === "lookahead" || node.kind === "lookbehind") &&
          node.alternatives.some((a) => this.containsBackref(a))
        );
      default:
        return false;
    }
  }

  /** Does `node` (on its own, fully anchored) match `s`? */
  private matches(node: Node, s: string): boolean {
    if (!this.containsBackref(node)) {
      const re = this.compile(node.raw);
      if (re) return re.test(s);
    }
    // Fallback: approximate with the set of consumable characters.
    const cs = this.chars(node);
    return [...s].every((c) => cs.has(c));
  }

  /** Probe characters `node` can consume anywhere. */
  private chars(node: Node): Set<string> {
    const hit = this.charsCache.get(node);
    if (hit) return hit;
    let out = new Set<string>();
    const leaf = this.leafSets.get(node);
    if (leaf) out = leaf;
    else if (node.type === "Quantifier") out = this.chars(node.element);
    else if (node.type === "Alternative")
      node.elements.forEach((e) => this.chars(e).forEach((c) => out.add(c)));
    else if (
      node.type === "Group" ||
      node.type === "CapturingGroup" ||
      node.type === "Pattern"
    )
      node.alternatives.forEach((a) => this.chars(a).forEach((c) => out.add(c)));
    else if (node.type === "Backreference") out = new Set(PROBE);
    this.charsCache.set(node, out);
    return out;
  }

  private nullable(node: Node): boolean {
    switch (node.type) {
      case "Assertion":
        return true;
      case "Quantifier":
        return node.min === 0 || this.nullable(node.element);
      case "Alternative":
        return node.elements.every((e) => this.nullable(e));
      case "Group":
      case "CapturingGroup":
        return node.alternatives.some((a) => this.nullable(a));
      case "Backreference":
        return true;
      default:
        return false;
    }
  }

  /** A cheap example string matched by `node`. */
  private sample(node: Node): string {
    switch (node.type) {
      case "Character":
        return String.fromCodePoint(node.value);
      case "CharacterSet":
      case "CharacterClass":
      case "ExpressionCharacterClass": {
        const set = this.leafSets.get(node);
        return set && set.size ? set.values().next().value! : "";
      }
      case "Quantifier":
        return this.sample(node.element).repeat(Math.min(node.min, 50));
      case "Alternative":
        return node.elements.map((e) => this.sample(e)).join("");
      case "Group":
      case "CapturingGroup":
        return this.sample(node.alternatives[0]);
      default:
        return "";
    }
  }

  /** Example text needed to reach `node` from the start of the pattern. */
  private prefixFor(node: Node): string {
    const path: Node[] = [];
    for (let n: Node | null = node; n; n = n.parent as Node | null) path.unshift(n);
    let out = "";
    for (let i = 0; i < path.length - 1; i++) {
      const p = path[i];
      if (p.type === "Alternative") {
        const idx = p.elements.indexOf(path[i + 1] as AST.Element);
        for (const e of p.elements.slice(0, idx)) out += this.sample(e);
      }
    }
    return out;
  }

  /** Alternatives of a loop body, unwrapping single-element groups. */
  private bodyAlternatives(body: Node): AST.Alternative[] {
    let n: Node = body;
    while (true) {
      if ((n.type === "Group" || n.type === "CapturingGroup") && n.alternatives.length > 1)
        return n.alternatives;
      if (
        (n.type === "Group" || n.type === "CapturingGroup") &&
        n.alternatives.length === 1 &&
        n.alternatives[0].elements.length === 1
      ) {
        n = n.alternatives[0].elements[0];
        continue;
      }
      return [];
    }
  }

  /** Flatten an alternative's elements, inlining single-alternative groups. */
  private flatten(elements: AST.Element[]): AST.Element[] {
    const out: AST.Element[] = [];
    for (const e of elements) {
      if ((e.type === "Group" || e.type === "CapturingGroup") && e.alternatives.length === 1)
        out.push(...this.flatten(e.alternatives[0].elements));
      else out.push(e);
    }
    return out;
  }

  private candidates(body: Node): string[] {
    const cs = this.chars(body);
    const reps = this.reps.filter((c) => cs.has(c)).slice(0, MAX_REPS);
    const out = [...reps];
    for (const a of reps) for (const b of reps) out.push(a + b);
    return out;
  }

  /** Find a suffix that makes the whole regex fail after prefix + pumpⁿ. */
  private failingSuffix(prefix: string, pump: string, n: number): string | null {
    const pumpChars = new Set(pump);
    const order = [
      ...this.reps.filter((c) => !pumpChars.has(c)),
      "",
      ...this.reps.filter((c) => pumpChars.has(c)),
    ];
    const body = prefix + pump.repeat(n);
    for (const s of order) {
      this.full.lastIndex = 0;
      if (!this.full.test(body + s)) return s;
    }
    return null;
  }

  // ---------- checks ----------

  checkExponential(q: Quantifier): Finding[] {
    const body = q.element;
    const alts = this.bodyAlternatives(body);
    const prefix = this.prefixFor(q);
    const span = { start: q.start, end: q.end };

    for (const w of this.candidates(body)) {
      if (!this.matches(body, w)) continue;

      if (this.matches(body, w + w)) {
        return [
          this.finish({
            severity: "exponential",
            rule: "nested-quantifier",
            title: "Nested quantifier",
            detail: `The loop body ${code(body.raw)} matches both ${show(w)} and ${show(
              w + w,
            )}, so ${show(w)}ⁿ can be split into iterations in exponentially many ways.`,
            spans: [span],
            prefix,
            pump: w,
          }),
        ];
      }

      const hits = alts.filter((a) => this.matches(a, w));
      if (hits.length >= 2) {
        return [
          this.finish({
            severity: "exponential",
            rule: "overlapping-alternation",
            title: "Overlapping alternation in a loop",
            detail: `Alternatives ${hits
              .slice(0, 3)
              .map((a) => code(a.raw))
              .join(" and ")} can both match ${show(
              w,
            )}, so every iteration doubles the paths to try.`,
            spans: [span, ...hits.map((a) => ({ start: a.start, end: a.end }))],
            prefix,
            pump: w,
          }),
        ];
      }
    }
    return [];
  }

  checkPolynomial(alt: AST.Alternative): Finding | null {
    const els = this.flatten(alt.elements);
    const top = alt.parent.type === "Pattern";
    const startsAnchored =
      els[0]?.type === "Assertion" && els[0].kind === "start";
    const implicit = top && !startsAnchored && !this.flags.includes("y");

    let best: { chain: (Quantifier | null)[]; c: string } | null = null;

    for (const c of this.reps) {
      // Longest chain of loops consuming `c`, separated only by nullable elements.
      // `null` stands for the engine's implicit "retry at every offset" loop.
      let chain: (Quantifier | null)[] = implicit ? [null] : [];
      let bestHere = chain;
      for (const e of els) {
        if (e.type === "Quantifier" && e.max >= LOOP_THRESHOLD && this.matches(e.element, c))
          chain = [...chain, e];
        else if (!this.nullable(e) && !this.matches(e, c)) chain = [];
        if (chain.length > bestHere.length) bestHere = chain;
      }
      if (bestHere.length >= 2 && (!best || bestHere.length > best.chain.length)) {
        best = { chain: bestHere, c };
      }
    }

    if (!best) return null;
    const loops = best.chain.filter((x): x is Quantifier => x !== null);
    const degree = best.chain.length;
    const implicitUsed = best.chain[0] === null;
    const detail =
      (implicitUsed
        ? `The pattern isn't anchored with ^, so the engine retries from every offset; `
        : "") +
      `${loops.map((q) => code(q.raw)).join(" → ")} can all consume ${show(
        best.c,
      )}, so a run of n ${show(best.c)}s has ~n${sup(degree)} ways to be divided before failing.`;

    return this.finish({
      severity: "polynomial",
      degree,
      rule: "adjacent-quantifiers",
      title: implicitUsed && loops.length === 1 ? "Unanchored loop" : "Overlapping adjacent loops",
      detail,
      spans: loops.map((q) => ({ start: q.start, end: q.end })),
      prefix: this.prefixFor(loops[0]),
      pump: best.c,
    });
  }

  private finish(
    f: Omit<Finding, "suffix" | "exploitable">,
  ): Finding {
    // Keep n tiny: this runs on the main thread against a pattern we already
    // suspect is catastrophic. Whether a suffix forces failure rarely depends on n.
    const suffix = this.failingSuffix(f.prefix, f.pump, 4);
    return { ...f, suffix: suffix ?? "", exploitable: suffix !== null };
  }
}

// ---------- formatting ----------

export function show(s: string): string {
  return JSON.stringify(s);
}
function code(s: string) {
  return "`" + s + "`";
}
function sup(n: number) {
  return String(n).replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)]);
}

/** Split "/pattern/flags" input into parts; plain text is treated as a pattern. */
export function parseInput(input: string): { source: string; flags: string } | null {
  const m = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(input.trim());
  return m ? { source: m[1], flags: m[2] } : null;
}
