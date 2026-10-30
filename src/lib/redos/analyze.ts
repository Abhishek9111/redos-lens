import { RegExpParser, visitRegExpAST, type AST } from "@eslint-community/regexpp";
import { show, sup } from "./format";

/**
 * Static ReDoS analysis for JavaScript (backtracking) regexes.
 *
 * Approach: walk the AST and, for every unbounded loop, search for a short
 * "pump" string that the loop can consume in more than one way. Instead of
 * building an NFA by hand, ambiguity is tested by compiling small sub-patterns
 * with the real engine, on strings short enough that nothing can blow up.
 *
 *  - Exponential (EDA): loop body B can match a string t in one iteration and
 *    also split it across two, or two alternatives of B both match t. Then
 *    B* has exponentially many ways to consume tⁿ.
 *  - Polynomial (IDA): k loops in sequence (only nullable stuff between them)
 *    that can all consume the same character. Unanchored patterns get an
 *    implicit leading loop, because the engine retries at every offset.
 *
 * A finding is only "exploitable" if the generated input reaches the loop and
 * some suffix then makes the overall match fail. Otherwise the engine returns
 * on the first path and never backtracks.
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
  /** Whether generated input reaches the loop and a suffix forces backtracking. */
  exploitable: boolean;
  /** Why a finding isn't exploitable. */
  blocked?: "always-matches" | "unreached";
}

export interface Analysis {
  source: string;
  flags: string;
  error?: string;
  verdict: "safe" | "possible" | "polynomial" | "exponential" | "invalid";
  findings: Finding[];
  notes: string[];
}

type Quantifier = AST.Quantifier;
type Node = AST.Node;

const BASE_PROBE: string[] = (() => {
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
  out.push("\x7f", "é", "ß", "İ", "\u00a0", "\u2028", "€", "中");
  return out;
})();

// Evenly spaced characters, so classes like \p{Script=Cyrillic} have something to match.
const WIDE_PROBE: string[] = (() => {
  const out: string[] = [];
  for (let c = 0x80; c < 0x3000; c += 0x20) out.push(String.fromCharCode(c));
  out.push("\u3041", "\u30a1", "\uac00", "\uff21");
  return out;
})();

const ASTRAL_PROBE = ["😀", "𝒜"]; // only single characters under the u and v flags

const LOOP_THRESHOLD = 10; // {n,m} with m ≥ this is treated as a loop
const MAX_REPS = 16;
const MAX_TRIPLE_REPS = 6;
const MAX_PATHS = 64;

export function analyze(source: string, flags: string): Analysis {
  const base: Analysis = { source, flags, verdict: "safe", findings: [], notes: [] };

  let full: RegExp;
  try {
    new RegExp(source, flags);
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
  const polynomial = ctx.alternatives
    .flatMap((alt) => ctx.checkPolynomial(alt) ?? [])
    .sort((a, b) => (b.degree ?? 2) - (a.degree ?? 2));
  for (const f of polynomial) {
    // Skip findings that are just a symptom of a stronger one on the same loops.
    const pool = findings.filter((x) => x.exploitable || !f.exploitable);
    const covered = f.spans.every((s) =>
      pool.some((x) => x.spans.some((e) => e.start <= s.start && s.end <= e.end)),
    );
    if (!covered) findings.push(f);
  }

  if (ctx.hasBackrefLoop()) {
    base.notes.push(
      "Loops containing backreferences can't be tested on their own and were skipped, so this result doesn't cover them.",
    );
  }
  if (ctx.compileFailures > 0) {
    base.notes.push(
      `${ctx.compileFailures} sub-pattern(s) couldn't be tested in isolation and were skipped.`,
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
      : findings.some((f) => f.blocked === "unreached")
        ? "possible"
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
  compileFailures = 0;

  private leafSets = new Map<Node, Set<string>>();
  private leafCache = new Map<string, Set<string>>();
  private probe: string[];
  private reps: string[];
  private testFlags: string;
  private reCache = new Map<string, RegExp | null>();
  private charsCache = new Map<Node, Set<string>>();
  private backrefCache = new Map<Node, boolean>();
  private sampling = new Set<Node>();

  constructor(
    private pattern: AST.Pattern,
    private flags: string,
    private full: RegExp,
  ) {
    // Flags that don't change what a sub-pattern matches in isolation.
    this.testFlags = [...flags].filter((f) => "isuv".includes(f)).join("");
    this.probe = this.buildProbe();
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
      case "Character":
      case "CharacterSet":
      case "CharacterClass":
      case "ExpressionCharacterClass":
        this.leafSets.set(node, this.probeLeaf(node));
        break;
    }
  }

  /** The shared probe characters plus the ones this pattern actually mentions. */
  private buildProbe(): string[] {
    const own: string[] = [];
    visitRegExpAST(this.pattern, {
      onCharacterEnter: (n) => void own.push(String.fromCodePoint(n.value)),
      onCharacterClassRangeEnter: (n) =>
        void own.push(String.fromCodePoint((n.min.value + n.max.value) >> 1)),
    });
    const astral = /[uv]/.test(this.flags) ? ASTRAL_PROBE : [];
    return [...new Set([...BASE_PROBE, ...own, ...WIDE_PROBE, ...astral])];
  }

  private probeLeaf(node: Node): Set<string> {
    const hit = this.leafCache.get(node.raw);
    if (hit) return hit;
    const re = this.compile(node.raw);
    const set = new Set(re ? this.probe.filter((c) => re.test(c)) : this.probe);
    this.leafCache.set(node.raw, set);
    return set;
  }

  /** One probe character per distinct "which leaves match me" signature. */
  private representatives(): string[] {
    const leaves = [...new Set(this.leafSets.values())];
    const seen = new Map<string, string>();
    for (const c of this.probe) {
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

  hasBackrefLoop(): boolean {
    return this.loops.some((q) => this.containsBackref(q.element));
  }

  private containsBackref(node: Node): boolean {
    let hit = this.backrefCache.get(node);
    if (hit === undefined) {
      hit = false;
      visitRegExpAST(node, { onBackreferenceEnter: () => void (hit = true) });
      this.backrefCache.set(node, hit);
    }
    return hit;
  }

  /**
   * Does `node`, on its own and fully anchored, match `s`? Nodes with
   * backreferences answer no: group numbers change when compiled alone.
   */
  private matches(node: Node, s: string): boolean {
    if (this.containsBackref(node)) return false;
    const re = this.compile(node.raw);
    return re ? re.test(s) : false;
  }

  /**
   * Can two non-empty iterations of `node` cover exactly `s`? Running them
   * side by side means \b and lookarounds see their real neighbours.
   */
  private splits(node: Node, s: string): boolean {
    if (this.containsBackref(node)) return false;
    const body = this.withoutGroupNames(node);
    const re = this.compile(`(?:${body})(?<=[\\s\\S])(?=[\\s\\S])(?:${body})`);
    return re ? re.test(s) : false;
  }

  /** `node.raw` with group names removed, so it can appear twice in one pattern. */
  private withoutGroupNames(node: Node): string {
    const names: AST.CapturingGroup[] = [];
    visitRegExpAST(node, {
      onCapturingGroupEnter: (g) => void (g.name !== null && names.push(g)),
    });
    let out = node.raw;
    for (const g of names.reverse()) {
      const at = g.start - node.start + 1; // just after the "("
      out = out.slice(0, at) + out.slice(at + `?<${g.name}>`.length);
    }
    return out;
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

  /** A cheap example string matched by `node`; `nonEmpty` runs optional loops once. */
  private sample(node: Node, nonEmpty = false): string {
    switch (node.type) {
      case "Character":
        return String.fromCodePoint(node.value);
      case "CharacterSet":
      case "CharacterClass":
      case "ExpressionCharacterClass": {
        const set = this.leafSets.get(node);
        return set && set.size ? set.values().next().value! : "";
      }
      case "Quantifier": {
        const times = Math.min(Math.max(node.min, nonEmpty ? 1 : 0), 50);
        return this.sample(node.element, nonEmpty).repeat(times);
      }
      case "Alternative":
        return node.elements.map((e) => this.sample(e, nonEmpty)).join("");
      case "Group":
      case "CapturingGroup":
        return this.sample(node.alternatives[0], nonEmpty);
      case "Backreference": {
        const group = [node.resolved].flat()[0];
        if (!group || this.sampling.has(group)) return "";
        this.sampling.add(group);
        const out = this.sample(group, nonEmpty);
        this.sampling.delete(group);
        return out;
      }
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

  /** Must a match starting at `e` begin at ^? If so, retrying at other offsets fails at once. */
  private anchored(e: Node | undefined): boolean {
    if (!e) return false;
    if (e.type === "Assertion") return e.kind === "start";
    if (e.type === "Quantifier") return e.min > 0 && this.anchored(e.element);
    if (e.type === "Group" || e.type === "CapturingGroup")
      return e.alternatives.every((a) => this.anchored(a.elements[0]));
    return false;
  }

  /**
   * Every sequence of elements `elements` can run through, opening up groups
   * and optional groups so a loop inside one still counts as adjacent.
   */
  private paths(elements: AST.Element[]): AST.Element[][] {
    let out: AST.Element[][] = [[]];
    for (const e of elements) {
      const options = this.options(e);
      if (out.length * options.length > MAX_PATHS) out = out.map((p) => [...p, e]);
      else out = out.flatMap((p) => options.map((o) => [...p, ...o]));
    }
    return out;
  }

  private options(e: AST.Element): AST.Element[][] {
    if (e.type === "Group" || e.type === "CapturingGroup")
      return e.alternatives.flatMap((a) => this.paths(a.elements));
    if (
      e.type === "Quantifier" &&
      e.max < LOOP_THRESHOLD &&
      (e.element.type === "Group" || e.element.type === "CapturingGroup")
    ) {
      const inner = this.options(e.element);
      return e.min === 0 ? [...inner, []] : inner;
    }
    return [[e]];
  }

  /** Strings to try as a pump: short combinations, then the body's own text. */
  private candidates(body: Node): string[] {
    const cs = this.chars(body);
    const reps = this.reps.filter((c) => cs.has(c)).slice(0, MAX_REPS);
    const small = reps.slice(0, MAX_TRIPLE_REPS);
    const out = new Set(reps);
    for (const a of reps) {
      for (const b of reps) {
        out.add(a + b);
        out.add(a + b + a + b);
      }
    }
    for (const a of small) for (const b of small) for (const c of small) out.add(a + b + c);

    const alts = this.bodyAlternatives(body);
    const samples = (alts.length ? alts : [body]).map((n) => this.sample(n, true));
    for (const a of samples) {
      out.add(a + a);
      for (const b of samples) out.add(a + b);
    }
    for (const a of samples) out.add(a);
    out.delete("");
    return [...out].sort((a, b) => a.length - b.length);
  }

  /**
   * Does `input` get through the pattern as far as the end of `loop`? Tested
   * by cutting the pattern off right after the loop and closing open groups.
   */
  private reaches(loop: Quantifier, input: string): boolean {
    let open = 0;
    for (let n: Node | null = loop.parent; n; n = n.parent as Node | null) {
      // Cutting inside a lookaround would change what it asserts.
      if (n.type === "Assertion") return true;
      if (n.type === "Group" || n.type === "CapturingGroup") open++;
    }
    try {
      const cut = this.pattern.raw.slice(0, loop.end) + "$" + ")".repeat(open);
      return new RegExp(cut, this.full.flags).test(input);
    } catch {
      return true;
    }
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
    if (this.containsBackref(body)) return [];

    const alts = this.bodyAlternatives(body);
    const prefix = this.prefixFor(q);
    const span = { start: q.start, end: q.end };
    let unconfirmed: Finding | null = null;

    for (const t of this.candidates(body)) {
      if (!this.matches(body, t)) continue;

      let found: Finding | null = null;
      if (this.splits(body, t)) {
        const half = t.slice(0, t.length / 2);
        const pump = half + half === t && this.matches(body, half) ? half : t;
        const overlapping = alts.length > 0;
        found = this.finish(
          {
            severity: "exponential",
            rule: overlapping ? "overlapping-alternation" : "nested-quantifier",
            title: overlapping ? "Overlapping alternation in a loop" : "Nested quantifier",
            detail: `The loop body ${code(body.raw)} can match ${show(
              t,
            )} in one iteration or split it across two, so ${show(
              pump,
            )}ⁿ can be divided in exponentially many ways.`,
            spans: [span],
            prefix,
            pump,
          },
          q,
        );
      } else {
        const hits = alts.filter((a) => this.matches(a, t));
        if (hits.length >= 2) {
          found = this.finish(
            {
              severity: "exponential",
              rule: "overlapping-alternation",
              title: "Overlapping alternation in a loop",
              detail: `Alternatives ${hits
                .slice(0, 3)
                .map((a) => code(a.raw))
                .join(" and ")} can both match ${show(
                t,
              )}, so every iteration doubles the paths to try.`,
              spans: [span, ...hits.map((a) => ({ start: a.start, end: a.end }))],
              prefix,
              pump: t,
            },
            q,
          );
        }
      }

      if (found?.exploitable) return [found];
      unconfirmed ??= found;
    }
    return unconfirmed ? [unconfirmed] : [];
  }

  checkPolynomial(alt: AST.Alternative): Finding | null {
    const top = alt.parent.type === "Pattern";
    let best: { chain: (Quantifier | null)[]; c: string } | null = null;

    for (const path of this.paths(alt.elements)) {
      const implicit = top && !this.anchored(path[0]) && !this.flags.includes("y");

      for (const c of this.reps) {
        // Longest chain of loops consuming `c`, separated only by nullable elements.
        // `null` stands for the engine's implicit "retry at every offset" loop.
        let chain: (Quantifier | null)[] = implicit ? [null] : [];
        let bestHere = chain;
        for (const e of path) {
          const quantified = e.type === "Quantifier";
          const consumes = this.matches(quantified ? e.element : e, c);
          if (quantified && e.max >= LOOP_THRESHOLD && consumes) chain = [...chain, e];
          else if (!this.nullable(e) && !consumes) chain = [];
          if (chain.length > bestHere.length) bestHere = chain;
        }
        if (bestHere.length >= 2 && (!best || bestHere.length > best.chain.length)) {
          best = { chain: bestHere, c };
        }
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

    return this.finish(
      {
        severity: "polynomial",
        degree,
        rule: "adjacent-quantifiers",
        title: implicitUsed && loops.length === 1 ? "Unanchored loop" : "Overlapping adjacent loops",
        detail,
        spans: loops.map((q) => ({ start: q.start, end: q.end })),
        prefix: this.prefixFor(loops[0]),
        pump: best.c,
      },
      loops[0],
    );
  }

  private finish(f: Omit<Finding, "suffix" | "exploitable" | "blocked">, loop: Quantifier): Finding {
    // Keep n tiny: this can run against a pattern we already suspect is
    // catastrophic. Whether a suffix forces failure rarely depends on n.
    const n = 4;
    if (!this.reaches(loop, f.prefix + f.pump.repeat(n)))
      return { ...f, suffix: "", exploitable: false, blocked: "unreached" };
    const suffix = this.failingSuffix(f.prefix, f.pump, n);
    if (suffix === null) return { ...f, suffix: "", exploitable: false, blocked: "always-matches" };
    return { ...f, suffix, exploitable: true };
  }
}

function code(s: string) {
  return "`" + s + "`";
}
