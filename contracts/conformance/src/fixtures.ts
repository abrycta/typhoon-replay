// Golden answers for the deterministic fixture in contracts/db/seed. Regenerate them if the seed changes.
export const HAIYAN = '2013306N07162';
export const RAI = '2021346N05145';
export const KHANUN = '2023207N09141';
export const UNNAMED_1946 = '1946316N07133';
export const TACLOBAN = 'PH-0831600000';
export const NAHA = 'JP-47201';
export const ORMOC = 'PH-0803738000';
export const GUIUAN = 'PH-0802616000';

/** All fixture storms in `season-desc` order (ties by sid). */
export const STORMS_SEASON_DESC = [
  '2023207N09141', '2022254N24143', '2021346N05145', '2020299N11144', '2019278N16165',
  '2018239N11161', '2013306N07162', '2009268N14128', '1946316N07133',
];

export const TACLOBAN_100KM = [
  { sid: HAIYAN, closestApproachKm: 27.0, closestApproachAt: '2013-11-08T00:00:00Z', maxWindKtWithinRadius: 168, hoursWithinRadius: 6 },
  { sid: UNNAMED_1946, closestApproachKm: 88.0, closestApproachAt: '1946-11-13T00:00:00Z', hoursWithinRadius: 2 },
];
/** Tacloban at 200 km sorted by peak-wind-desc (unknown wind last). */
export const TACLOBAN_200KM_PEAK_WIND = [HAIYAN, RAI, UNNAMED_1946];
export const NAHA_100KM = [{ sid: KHANUN, closestApproachKm: 76.6, maxWindKtWithinRadius: 119, hoursWithinRadius: 13 }];
export const HAIYAN_PLACES_100KM = [ORMOC, GUIUAN, TACLOBAN];

/** Fixed problem titles per code (ProblemCode). */
export const PROBLEM_TITLES: Record<string, string> = {
  validation: 'Request validation failed',
  'invalid-cursor': 'Invalid cursor',
  'not-found': 'Not found',
  'method-not-allowed': 'Method not allowed',
  'not-acceptable': 'Not acceptable',
  'payload-too-large': 'Payload too large',
  'unsupported-media-type': 'Unsupported media type',
  'rate-limited': 'Too many requests',
  internal: 'Internal server error',
  'not-ready': 'Service not ready',
  'stream-capacity': 'Too many live streams',
};
export const PROBLEM_BASE = 'https://replay.krtmtthw.dev/problems/';

export const MAX_RESPONSE_BYTES = 64 * 1024;
