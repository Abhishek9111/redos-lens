# redos-lens: Architecture

This document explains how the app is built: what each piece does, how data moves between pieces, and why it is designed this way.

---

## 1. What it does

You type a regex and the app tells you whether a crafted input can make it hang. It does that in two phases:

| Phase | Question it answers | Speed | Where it runs |
|---|---|---|---|
| **Static analysis** | "Is this regex *structurally* able to blow up?" | ~1 ms, runs on every keystroke | Long-lived Web Worker |
| **Dynamic timing** | "Does it *actually* blow up in this browser's engine?" | Seconds, runs only when you click **Measure** | Throwaway Web Worker |

Nothing is sent to a server. Next.js only serves the page; all the work happens in the browser.

---

## 2. Terms you need

| Term | Meaning |
|---|---|
| **Backtracking** | When a regex path fails, the engine goes back and tries another way to match. JS, Python, Java and PCRE all work like this. |
| **ReDoS** | Regex Denial of Service. An input that makes the number of paths explode, so one `.test()` call blocks the thread for seconds or hours. |
| **Loop** | Any quantifier that can repeat many times: `*`, `+`, `{2,}`, or `{n,m}` with `m ≥ 10`. |
| **Ambiguity** | The same text can be matched by the regex in more than one way. Ambiguity inside a loop is the root cause of ReDoS. |
| **Pump** | The short string that gets repeated to trigger the blowup, e.g. `"a"` for `(a+)+$`. |
| **Prefix** | Text needed to *reach* the vulnerable loop, e.g. `"a@a."` in an email regex. |
| **Suffix** | One character appended to force the overall match to **fail**. Without a failure the engine returns on its first path and never backtracks. |
| **Attack string** | `prefix + pump × n + suffix` |
| **Exponential** | Time doubles (roughly) per extra pump. About 30 characters can hang a server. |
| **Polynomial O(nᵏ)** | Time grows as length² or length³. You need large inputs (10 KB to 1 MB), but it is still dangerous on unbounded input. |
| **Exploitable** | The generated input reaches the loop, and a suffix then makes the match fail, so the backtracking actually happens. |

---

## 3. Big picture

```
┌──────────────────────────── Browser tab ──────────────────────────────┐
│                                                                       │
│  MAIN THREAD (React)                                                  │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ Checker  ──useAnalysis()──────┐            FindingCard          │  │
│  │   │                           │              │ "Measure" click  │  │
│  │   │ renders Analysis          │              ▼                  │  │
│  │   ├─ Banner (verdict)         │           runTiming()           │  │
│  │   ├─ PatternView (highlight)  │              │                  │  │
│  │   └─ FindingCard × N ─────────┼──────────────┤                  │  │
│  │                               │              │ samples stream   │  │
│  │                               │              ▼                  │  │
│  │                               │           TimingChart           │  │
│  └───────────────────────────────┼──────────────┼──────────────────┘  │
│              postMessage ▲   ▼   │              │   ▲  ▼ postMessage   │
│  ┌───────────────────────────────┴──┐  ┌────────┴───────────────────┐ │
│  │ ANALYSIS WORKER (long-lived)     │  │ TIMING WORKER (per click)  │ │
│  │  worker.ts → analyze()           │  │  worker.ts → time loop     │ │
│  │  watchdog: killed after 2 s      │  │  watchdog: killed after 3 s│ │
│  └──────────────────────────────────┘  │  per run                   │ │
│                                        └────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘
```

**The one rule behind the design:** the main thread never runs a suspicious regex. Anything that could hang runs in a worker, and the main thread holds a timer that can call `worker.terminate()`. A hung worker cannot stop the main thread from killing it.

---

## 4. Folder map

```
src/
├── app/
│   ├── layout.tsx          Root HTML shell, fonts, metadata
│   ├── page.tsx            Server component: heading, footer, mounts <Checker/>
│   └── globals.css         Color tokens (light/dark) wired into Tailwind
│
├── components/             UI only, no regex logic
│   ├── Checker.tsx         Input, example chips, verdict banner, findings list
│   ├── FindingCard.tsx     One finding: explanation, attack string, Measure/Copy
│   ├── PatternView.tsx     The pattern with the vulnerable part highlighted
│   └── TimingChart.tsx     SVG chart of time vs input length, plus table view
│
└── lib/redos/              Logic, no React (except client.ts hooks)
    ├── analyze.ts          ★ The static analyzer: pure function analyze(source, flags)
    ├── format.ts           Small shared helpers, including /pattern/flags parsing
    ├── worker.ts           Worker entry: handles "analyze" and "time" messages
    └── client.ts           Main-thread side: spawns workers, watchdogs, growth math
```

**Layering:** `components → client.ts → (postMessage) → worker.ts → analyze.ts`.
`analyze.ts` has no idea that React or workers exist. You can run it in Node, which is how it was tested.

---

## 5. Data flow

### 5a. Typing a pattern (static phase)

```
keystroke
  → Checker: setSource()  (pasting "/abc/gi" over the whole field splits it into pattern + flags)
  → useAnalysis(source, flags)
       ├ wait 150 ms (debounce: no work while you are typing)
       ├ start a 2 s watchdog timer
       └ postMessage({ kind: "analyze", id, source, flags })
  → worker.ts: analyze(source, flags) → Analysis
  → postMessage({ kind: "analysis", id, result })
  → useAnalysis: ignore it if the id is stale, clear the watchdog, setState(done)
  → Checker renders: Banner + PatternView + FindingCard per finding
```

If the watchdog fires first, the worker is terminated, a fresh one is created on the next keystroke, and the UI shows "Analysis timed out".

**Why an `id` on every message:** you can type faster than analysis finishes. Each request gets a unique id, and the handler drops responses whose id doesn't match the latest request, so an old result never overwrites a new one.

### 5b. Clicking "Measure in sandbox" (dynamic phase)

```
click
  → runTiming(source, flags, finding, onSample, onDone)
       ├ spawn a NEW worker (never reused, it may need to be killed)
       └ postMessage({ kind: "time", prefix, pump, suffix, sizes, budgetMs: 400 })

worker loop, for each n in sizes:
       post "start" {n, length}        ← main thread arms a 3 s kill timer
       run re.test(prefix + pump×n + suffix), measure ms
       post "sample" {n, length, ms}   ← main thread disarms it, chart adds a point
       if ms > 400 → stop (enough data, no need to go bigger)
  post "done"                          ← main thread terminates the worker

if the kill timer fires:
       record { killed: true }, terminate the worker, stop
```

**Why the `start` message:** if the worker hangs, it can't report which input hung it. Sending `start` *before* each run means the main thread already knows the input size when it has to kill the worker.

**Input sizes** (`sizesFor`):
- Exponential: n = 4, 6, 8 … 48 pumps (small, because each step roughly doubles the time)
- Polynomial: lengths of 256, 512 … 1 MB characters (doubling, because growth is slow)

---

## 6. The static analyzer (`analyze.ts`) in depth

This is the core of the project. Everything else is plumbing and UI.

### 6.1 The core idea

Proving a regex unsafe usually means building an NFA (a state-machine graph) and searching it for ambiguous loops. That's correct but a lot of code. This analyzer takes a shortcut:

> **Use the real JS regex engine as the oracle, but only on tiny strings (1–4 chars), where nothing can blow up.**

For example, to ask "can the loop body `(a+)` match `"aa"`?", it compiles `/^(?:a+)$/` and calls `.test("aa")`. That runs in microseconds and is exact, because the engine applies all of its own rules for escapes, classes, flags and Unicode.

To ask "can two iterations cover the same text?", it runs the body twice side by side in one regex. Because both copies run in the same string, `\b` and lookarounds see their real neighbours.

### 6.2 Pipeline

```
analyze(source, flags)
  │
  ├─ 1. Validate  new RegExp(source, flags)       → if invalid: verdict "invalid"
  ├─ 2. Parse     regexpp.parsePattern()          → AST (tree of nodes)
  ├─ 3. Context   walk the AST once and collect:
  │                 • loops[]          every Quantifier with max ≥ 10
  │                 • alternatives[]   every sequence of elements
  │                 • leafSets         for each char-matching node, which probe chars it matches
  │                 • hasBackref
  │               then compute representatives (see 6.3)
  ├─ 4. Exponential check, once per loop        → Finding[]
  ├─ 5. Polynomial check, once per alternative  → Finding | null
  │       (skipped if an exponential finding already covers those loops)
  ├─ 6. Sort: exploitable first, then exponential > O(n³) > O(n²)
  └─ 7. Verdict = worst *exploitable* finding, else "possible" if a loop
          couldn't be reached, else "safe"
```

### 6.3 Probe alphabet and representatives

You can't test every Unicode character, so the analyzer works with a **probe alphabet**: a–z, A–Z, 0–9, ASCII punctuation and control characters, every character the pattern itself mentions, and an evenly spaced sample of other scripts so that classes like `\p{Script=Cyrillic}` have something to match.

Most of those characters behave identically for a given regex. In `^[a-z]+@\d+$`, the characters `b` and `q` are interchangeable. So each probe char gets a **signature**: which leaf nodes match it.

```
leaves:        [a-z]   @    \d
'a'  →          1      0    0     signature "100"
'b'  →          1      0    0     signature "100"  ← same as 'a', skip
'@'  →          0      1    0     "010"
'5'  →          0      0    1     "001"
'!'  →          0      0    0     "000"  ← "matches nothing", useful as a failing suffix
```

One character per signature is kept as a **representative**. Typical regexes have 3–15 of them, which keeps every later search small.

### 6.4 Exponential check (per loop)

Two rules. Each one has a known exploit shape.

**Rule A: one iteration or two.** Loop body `B` can match a string `t` in one iteration, and can also split `t` across two non-empty iterations.

```
(a+)+        t = "aa"   one: [aa]    two: [a][a]    → vulnerable
(a|b|ab)*    t = "ab"   one: [ab]    two: [a][b]    → vulnerable
```

Why: every copy of `t` in the input gives the engine a two-way choice, so n copies give 2ⁿ paths, and it tries every one before giving up.

**Rule B: overlapping alternation.** Two alternatives inside `B` both match the same `t`.

```
(\d|\w)+   "0" matches \d ✓ and \w ✓          → vulnerable
```

Why: each character has two choices, so n characters give 2ⁿ paths.

**The search:** try short strings, shortest first: single characters, pairs, a limited set of triples, doubled pairs, and text sampled from the body itself (so `((abc)+)+` tries `"abcabc"` and `(foo|bar|foobar)*` tries `"foobar"`). If a candidate is unexploitable, the search keeps going and only falls back to it when nothing better turns up.

Counter-examples (correctly not flagged):
- `(a+b)*`: body needs a `b`, so `"aa"` isn't a match
- `(ab)*`: body matches `"ab"` but not `"abab"`
- `(\b\w+\b\s*)*`: `"aa"` can't be split, because `\b` fails between two letters

### 6.5 Polynomial check (per alternative)

**Rule C: overlapping adjacent loops.** Within one sequence, if k loops can all consume the same character c, and everything *between* them is either optional or also matches c, then a run of n c's can be divided among the loops in ~nᵏ ways.

```
^\d+\d+$     two loops eat "1"                     → O(n²)
.*.*=        implicit + two loops eat "a"          → O(n³)
```

**The implicit loop:** a pattern without a leading `^` is retried by the engine at every start offset. That behaves like an invisible `[\s\S]*?` at the front, so the checker adds a virtual loop (`null` in the chain) at the start of top-level alternatives.

```
\s+$         implicit loop + \s+ both eat " "       → O(n²)
```

**How the chain is built:** the alternative is first opened up into **paths**, one for each route through its groups and optional groups (`(a+)?a+` becomes `a+ a+` and `a+`, capped at 64). Then for each path and each representative c, walk the elements left to right:
- a loop that matches c → extend the chain
- an optional element, or one that matches c → keep the chain going
- anything else → break the chain, start over

The longest chain over all c gives k (the degree).

*Why paths:* a loop inside a group is still next to whatever follows the group. Without paths, `(?:\s+|x)$` and `(a+)?a+` would look safe. The implicit loop follows the same paths, and it's skipped when every route starts with `^`, as in `(^a+)+$`.

### 6.6 Exploitability (reaching the loop, then forcing failure)

A finding is only real if two things hold, checked in `finish()`:

1. **The input reaches the loop.** `reaches()` cuts the pattern off right after the loop, adds `$`, closes any open groups, and tests `prefix + pump × 4` against it. A failure here is recorded as `blocked: "unreached"`, and the verdict becomes **possible** rather than safe, because the generated input may simply be too naive. The check is skipped for loops inside lookarounds, where cutting would change the meaning.
2. **The overall match can fail.** `failingSuffix(prefix, pump, 4)` tries suffixes in this order: characters that are *not* in the pump (most likely to break the match), then the empty string, then the rest. It returns the first one where `fullRegex.test(prefix + pump×4 + suffix)` is false. If none works, the finding is recorded as `blocked: "always-matches"`.

- `(a+)+$` with suffix `"b"` → the match fails → **exploitable**
- `(a+)+` with no `$` → it matches `"aaaa"` immediately whatever follows → **not exploitable** (still shown, greyed out)
- `^(?!a)(a+)+$` → the lookahead rejects the pump before the loop → **possible**

**Why n = 4 and not 40:** this runs on a regex already suspected of being catastrophic. An earlier version used 40, and `(a+)+$` on 40 characters is about 2⁴⁰ steps, so the analyzer hung itself. Whether a suffix makes the match fail almost never depends on n.

### 6.7 Helper functions

| Helper | What it answers |
|---|---|
| `compile(body)` | `/^(?:body)$/` with only the flags that matter (`i s u v`), cached. Returns `null` if the fragment can't stand alone. |
| `matches(node, s)` | "Does this node, on its own, match exactly `s`?" Uses the real engine. Nodes with backreferences answer no, because group numbers change when compiled alone. |
| `splits(node, s)` | "Can two non-empty iterations of this node cover exactly `s`?" |
| `reaches(loop, input)` | "Does this input get through the pattern as far as the end of the loop?" (see 6.6) |
| `anchored(node)` | "Must a match starting here begin at `^`?" |
| `chars(node)` | Every probe character this node could consume anywhere. Cached. |
| `nullable(node)` | Can this node match the empty string? (e.g. `a?`, `a*`, lookarounds) |
| `sample(node)` | A cheap example match, used to build prefixes. |
| `prefixFor(node)` | Walks up via `.parent` and concatenates samples of everything before the node, giving text that reaches the loop. |
| `bodyAlternatives(B)` | The `|` branches of a loop body, unwrapping `((a|b))` → `[a, b]`. |
| `paths(elements)` | Every route through groups and optional groups (see 6.5). |
| `representatives()` | One char per signature (see 6.3). |

### 6.8 Output shape

```ts
Analysis {
  source, flags
  verdict: "safe" | "possible" | "polynomial" | "exponential" | "invalid"
  error?:  string               // only when invalid
  findings: Finding[]
  notes:    string[]            // caveats, e.g. "uses backreferences"
}

Finding {
  severity: "exponential" | "polynomial"
  degree?:  number              // k in O(nᵏ)
  rule:     "nested-quantifier" | "overlapping-alternation" | "adjacent-quantifiers"
  title, detail                 // human text; `code` is wrapped in backticks
  spans:    { start, end }[]    // [0] = the loop, rest = the overlapping parts
  prefix, pump, suffix          // the attack recipe
  exploitable: boolean
  blocked?: "always-matches" | "unreached"   // why it isn't exploitable
}
```

`spans` are character offsets into the pattern source, which `PatternView` uses for highlighting. They come straight from regexpp's `node.start` and `node.end`.

---

## 7. Worker protocol (`worker.ts`)

One worker file serves both jobs, and the `kind` field picks which.

| Direction | `kind` | Payload | Meaning |
|---|---|---|---|
| → worker | `analyze` | `source, flags` | Run the static analysis |
| ← worker | `analysis` | `result: Analysis` | Done |
| → worker | `time` | `source, flags, prefix, pump, suffix, sizes[], budgetMs` | Run the timing loop |
| ← worker | `start` | `n, length` | About to run this size (arm the kill timer) |
| ← worker | `sample` | `n, length, ms` | Finished this size |
| ← worker | `done` | – | All sizes done, or the budget was exceeded |
| ← worker | `error` | `message` | The job threw. Shown as a tool failure, never as a verdict on the pattern |

Every message carries an `id` so stale replies can be dropped.

The worker is created with `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`. Turbopack sees this pattern and bundles `worker.ts` (and its import of `analyze.ts` and `regexpp`) as a separate chunk. No extra config is needed.

---

## 8. Main-thread runtime (`client.ts`)

| Export | Role |
|---|---|
| `useAnalysis(source, flags)` | React hook. Debounces (150 ms), owns the long-lived analysis worker, arms the watchdog (2 s, or 10 s while a new worker starts up), respawns the worker after a kill. Returns `idle / running / done / timeout / error`. |
| `runTiming(...)` | Spawns a timing worker and wires up the start/sample/done handshake and the 3 s kill switch (`KILL_MS`). Returns a cancel function, which `FindingCard` calls on unmount or re-run. |
| `sizesFor(finding)` | The input-size schedule (see 5b). |
| `describeGrowth(finding, samples, running)` | Turns raw timings into a verdict sentence (below). |
| `fmtMs(ms)` | Formats `0.42 ms / 120 ms / 3.1 s / 4.2 min / 1.3 h`. |

### Growth math

It fits a straight line (least squares) through the last four samples that took at least 1 ms, because one noisy timing can swing a two-point estimate a lot.

- **Exponential:** the slope of `log(ms)` against the pump count gives the factor per pump. It extrapolates how many characters it takes to reach 10 s.
- **Polynomial:** the slope of `log(ms)` against `log(length)` gives the exponent k. It extrapolates the time for 100 KB and 1 MB inputs.

### Confirmed vs not reproduced

Measured results can disagree with the static analysis. In testing, `\s+$` was clearly O(n²) in Node, but looked linear in the Chromium used by the browser pane. The cause of that difference hasn't been established.

So `describeGrowth` returns `{ confirmed, text }`:
- **confirmed:** the worker was killed, or the growth factor is above 1.15× per pump, or k ≥ 1.4.
- **not reproduced:** the UI says no slowdown appeared here, which means either a false alarm or an engine that handles the pattern better, and tells the reader to test in the engine they deploy on.

A killed run always counts as confirmed, whatever the earlier timings looked like. Findings that aren't exploitable have no Measure button.

The static result answers "does this regex look dangerous?" and the dynamic result answers "did it actually slow down in this browser?". The UI shows both and never lets one silently override the other.

---

## 9. UI components

```
page.tsx (server)
└── Checker (client)            owns: source, flags, selected finding
    ├── input row + example chips
    ├── Banner                  verdict / error / timeout
    ├── PatternView             highlights findings[selected].spans
    ├── FindingCard × N         owns: samples, running; click = select
    │   └── TimingChart         SVG line chart + hover tooltip + "Show as table"
    └── notes
```

- **State lives where it's used.** `Checker` holds the input; each `FindingCard` holds its own timing samples. There is no global store, because none is needed.
- **Each `FindingCard` is keyed by `source/flags/index`**, so editing the pattern resets old timing data instead of showing it next to a new regex.
- **Theming:** colors are CSS variables in `globals.css` (light, dark, and a `data-theme` override), exposed to Tailwind via `@theme inline` as `bg-surface`, `text-ink-2`, `text-critical`, etc. Verdicts always pair a color with an icon and a label, so they are never conveyed by color alone.

---

## 10. Design decisions and trade-offs

| Decision | Why | Cost |
|---|---|---|
| All regex execution in workers | A hung regex can't freeze the UI, and `terminate()` is a hard kill | Some message-passing boilerplate |
| Long-lived analysis worker, fresh timing worker | Analysis runs on every keystroke, so reuse it. Timing is expected to be killed, so make it disposable | – |
| Real engine on tiny strings instead of a hand-built NFA | Exact semantics for escapes, classes, flags and Unicode for free, with a small amount of code | It's a search over likely witnesses, not a proof, so a "safe" verdict can still be wrong |
| Probe alphabet + representatives | Keeps the search to tens of candidates instead of thousands | Exotic Unicode classes are sampled, not fully covered |
| Requiring the loop to be reached and a failing suffix | Removes whole classes of false positives (`(a+)+` without `$`, unreachable loops) | Naive prefixes can leave a real issue at "possible" |
| Static + dynamic, reported separately | Engines differ; the static result covers other engines, the timing covers this one | The user sees two signals and must read both |
| No server | Patterns can be sensitive (internal validators); nothing leaves the browser | – |

---

## 11. Known limitations

- **Backreferences** (`\1`) aren't regular, so loops containing them are skipped, and the result says so in `notes`.
- **Lookarounds** count as nullable, and a loop inside one isn't checked for reachability.
- **The pump search is a sample, not exhaustive.** It covers single characters, pairs, some triples and text taken from the body. A very long pump the body can't suggest can be missed, and so can bounded cases like `(a{3,5})+`, where the ambiguity is between two different two-iteration splits.
- **Unusual characters are sampled.** A class that matches only characters outside the pattern's own text and the sampled ranges has nothing to probe with.
- **Prefix generation is naive:** first alternative, minimum repetitions. It can produce a prefix that doesn't reach the loop in complex patterns.
- **Loops are `max ≥ 10`.** `(a+){2,5}` isn't treated as an outer loop. It is bounded, but can still be slow in the worst case.
- **The timing result is engine-specific.** It shows the current browser's engine only.

---

## 12. Where to change things

| You want to… | Edit |
|---|---|
| Add a new detection rule | Add a `checkX()` method on `Context` in `analyze.ts`, call it in `analyze()`, and add a value to `Finding.rule` |
| Change which pumps are tried | `candidates()` in `analyze.ts` |
| Treat smaller bounded quantifiers as loops | `LOOP_THRESHOLD` in `analyze.ts` |
| Change the kill or startup timeouts, or timing sizes | `KILL_MS`, `STARTUP_MS`, `sizesFor()` in `client.ts`; `budgetMs` in `runTiming()` |
| Change the "confirmed" thresholds | `describeGrowth()` in `client.ts` |
| Add example patterns | `EXAMPLES` in `Checker.tsx` |
| Retheme | Tokens in `globals.css` |

---

## 13. Running it

```bash
npm install
npm run dev -- -p 3001
```

Run the tests with:

```bash
npm test
```

The analyzer is plain TypeScript with no DOM, so you can also exercise it directly:

```bash
npx tsx -e 'import {analyze} from "./src/lib/redos/analyze"; console.log(analyze("^(a+)+$","").findings)'
```
