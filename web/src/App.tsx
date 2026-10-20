import { buildInfo, formatBuildInfo } from "@/lib/build-info";

export default function App() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-8 text-center text-foreground">
      <h1 className="text-4xl font-semibold tracking-tight">Typhoon Replay</h1>
      <p className="text-lg text-muted-foreground">Coming soon.</p>
      <footer className="absolute bottom-4 font-mono text-xs text-muted-foreground">
        {formatBuildInfo(buildInfo)}
      </footer>
    </main>
  );
}
