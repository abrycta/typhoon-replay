export interface BuildInfo {
  commit: string;
  builtAt: string;
}

export const buildInfo: BuildInfo = {
  commit: __COMMIT_SHA__,
  builtAt: __BUILD_TIME__,
};

/** One-line build stamp, e.g. "build 1a2b3c4 · 2026-10-20 14:05 UTC". */
export function formatBuildInfo({ commit, builtAt }: BuildInfo): string {
  const sha = /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7) : commit;
  const date = new Date(builtAt);
  const when = Number.isNaN(date.getTime())
    ? builtAt
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `build ${sha} · ${when}`;
}
