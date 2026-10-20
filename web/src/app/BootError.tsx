/** Shown when config.json cannot be loaded (before i18n and the design system providers exist). */
export function BootError({ error }: { error: unknown }) {
  return (
    <main className="mx-auto grid min-h-dvh max-w-xl content-center gap-3 p-6">
      <h1 className="text-2xl font-semibold">Typhoon Replay could not start</h1>
      <p className="text-muted-foreground">The site configuration (config.json) did not load. Please reload the page.</p>
      <p lang="ja" className="text-muted-foreground">
        設定ファイルを読み込めませんでした。ページを再読み込みしてください。
      </p>
      <pre className="overflow-auto rounded-sm bg-muted p-3 text-xs">{error instanceof Error ? error.message : String(error)}</pre>
    </main>
  );
}
