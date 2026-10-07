# redos-lens

Finds regular expressions that can be forced into catastrophic backtracking (ReDoS), then proves it by timing them in a sandboxed Web Worker. Everything runs in the browser, so your patterns never leave your machine.

![redos-lens flagging the classic email regex as exponential](docs/screenshot.jpg)

## What it does

- **Static analysis on every keystroke.** It flags nested quantifiers like `(a+)+`, overlapping alternation like `(\d|\w)+`, and overlapping adjacent loops like `\d+\d+` or an unanchored `\s+$`.
- **Shows how to attack it.** Each finding comes with an attack recipe (`prefix + pump × n + suffix`), a copyable repro snippet, and the vulnerable part of the pattern highlighted.
- **Only reports what can actually happen.** A finding counts only if some input forces the overall match to fail. `(a+)+` is ambiguous but harmless; `(a+)+$` is not.
- **Proves it by timing.** The regex runs against growing inputs in a disposable worker with a 3 s kill switch, so a catastrophic pattern can't freeze the tab. The measured growth is then fitted, e.g. *"×2.01 per extra char"* or *"O(n^2.0)"*.
- **Reports engine differences.** If this browser's regex engine optimizes a pattern that's still vulnerable elsewhere (Node, PCRE, Java, Python), the result says so instead of calling the pattern safe.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## How it works

The short version: the analyzer parses the regex with [`@eslint-community/regexpp`](https://github.com/eslint-community/regexpp). For each loop it searches for a short "pump" string the loop can consume in more than one way, checking candidates against the real JS engine on 1–4 character inputs, where nothing can blow up. The main thread never runs a suspicious regex.

The full write-up (data flow, worker protocol, detection rules, trade-offs and limitations) is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Limitations

- Results describe backtracking engines. RE2 and Rust's `regex` are immune by design.
- Backreferences and lookarounds are approximated.
- The pump search covers strings of 1–2 characters, so rare ambiguities that need longer pumps can be missed.

## Stack

Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS 4.
