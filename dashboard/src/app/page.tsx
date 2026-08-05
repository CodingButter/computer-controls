// The Overview's placeholder. Phase 3 replaces this with the live health
// cards; the shell around it is already the real one.
export default function Home() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="rounded-xl border border-border bg-card p-8 text-center">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="mt-2 text-sm text-muted">Live health cards arrive in the next phase.</p>
      </div>
    </div>
  );
}
