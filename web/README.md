# web/

**Provisional placeholder; architecture pending, see docs/architecture/.**

A minimal Vite + React + TypeScript + Tailwind v4 page that exists only to
prove the build and Cloudflare Pages deploy path. The frontend framework may
change once the architecture is decided.

Swapping frameworks touches only `deploy.config` (commands) and
`wrangler.jsonc` (`pages_build_output_dir`) in the repo root; the scripts and
workflows read everything from there. Keep `public/_headers` (or move it into
the new framework's static folder so it ends up at the root of the build
output). See the root README, "Running & deploying".
