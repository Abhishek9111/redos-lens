import { Checker } from "@/components/Checker";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:py-16">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">ReDoS Checker</h1>
        <p className="mt-2 text-ink-2">
          Finds regexes that can be forced into catastrophic backtracking, then proves it by timing
          them in a sandboxed worker. Your patterns never leave the browser.
        </p>
      </header>
      <Checker />
      <footer className="mt-16 border-t border-line pt-6 text-xs leading-relaxed text-ink-3">
        Results apply to backtracking engines (JavaScript&apos;s V8, PCRE, Java, Python{" "}
        <code>re</code>). Linear-time engines such as RE2 and Rust&apos;s <code>regex</code> are
        immune. Backreferences and lookarounds are approximated.
      </footer>
    </main>
  );
}
