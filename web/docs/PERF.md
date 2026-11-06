# Load timings

First-visit load times for Replay's pages, measured the same way before and after each speed change. Work list:
the performance audit of 2026-10-22 (storm-page waterfall, Hugging Face hops, six sheets before the first frame, the
home page on phones).

## Method

`npm run perf -- --base <url>` (`scripts/measure-load.mjs`) loads each page three times, each in a fresh browser (empty
HTTP cache, Cache Storage and connection pool), against the real dataset host, and reports the median beside every run.

| Profile | Viewport | Network | CPU |
|---|---|---|---|
| desktop | 1366×850, DPR 1 | the measuring machine's own (a Mac in the Philippines, Cloudflare colo SIN) | 1× |
| iphone | iPhone 13 emulation (390×664, DPR 3, touch) | DevTools "Slow 4G": 562.5 ms RTT, 1.44 Mbit/s down, 675 kbit/s up; applied to the page and its workers (the decode worker fetches the field sheets) | 4× slowdown |

Milestones, in ms from the start of navigation:

- **ttfb**: the HTML's response headers reach the page (wall clock; the page's own `responseStart` leaves out the
  emulated latency).
- **fcp** / **lcp**: first contentful paint; the last largest contentful paint.
- **app**: React's first render has replaced the pre-load glyph.
- **frame**: the first full frame is on screen: basemap, track and field drawn (the map's first idle with a field
  frame sets the user-timing mark `replay:first-frame-drawn`; the map-slot glyph lifts at the same moment). The main
  number for the home and storm pages.
- **decoded**: the field frame at the playhead is decoded (`[data-frame-ready=true]`), drawn or not.
- **list**: the first storm card of a storm list is on the page.
- **req** / **KB**: requests and transferred bytes (encoded bodies plus headers, page and workers) until the page
  settles (2–5 s after the last milestone; map tiles and the exact readout sheets keep arriving after the frame).

Pages: `/` (featured Haiyan replay plus the recent-storms list), `/storm/2013306N07162` (Haiyan), `/storms`.

Limits: one machine and location, n = 3 per cell; treat differences under about 10 % as noise. The desktop row uses
a real (fast) connection and varies by day; the shaped iPhone row is steadier. Hugging Face and the OpenFreeMap tiles
are live third parties. Before/after pairs run back to back: the production Pages host (`typhoon-replay.pages.dev`,
same build as the live site) against the PR's preview (`pr-<n>.typhoon-replay.pages.dev`).

## First baseline (2026-10-23, live site, before the speed work; "frame" here = decoded)

This pass timed the decoded frame; the map's start-up can add a second or more before the drawn frame. The
drawn-frame baseline is below.

`https://replay.krtmtthw.dev` at `04ab7bd`, dataset v4 on Hugging Face. Medians of 3 cold runs, ms (raw runs:
[`perf-baseline-2026-10-23.json`](perf-baseline-2026-10-23.json)).

| Profile/page | ttfb | fcp | app | lcp | **frame** | **list** | req | KB |
|---|---|---|---|---|---|---|---|---|
| desktop/home | 158 | 472 | 440 | 2324 | **2518** | **1411** | 80 | 1443 |
| desktop/storm | 203 | 592 | 503 | 2484 | **2979** | – | 78 | 1253 |
| desktop/storms | 172 | 504 | 459 | 2412 | – | **1467** | 55 | 784 |
| iphone/home | 670 | 2400 | 3401 | 5844 | **12209** | **9343** | 82 | 1511 |
| iphone/storm | 660 | 2416 | 3415 | 7620 | **12316** | – | 83 | 1376 |
| iphone/storms | 669 | 2472 | 3414 | 7128 | – | **8469** | 55 | 784 |

Runs agree closely (iPhone frame: 12181, 12209, 12242 on home; 12214, 12372, 12316 on Haiyan). On the slow phone
link the first field frame lands about 12 s after navigation, 9 s after the app's first render.

### Backend cold starts (single samples, 2026-10-23)

Render free services sleep after 15 minutes idle. Cold first-request times: Java 47 s, Go 13 s (one sample each; the
hand-typed "≈100 s" for Java in `conformance.json` predates them). The replay never waits on a backend: its data is
static files.

## Changes

One row per speed change: what changed, and the same milestones before → after, measured back to back.
