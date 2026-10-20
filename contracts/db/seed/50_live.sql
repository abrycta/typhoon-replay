-- One active fixture storm (fictional advisory) applied through the same function the ingestion job uses.
DO $seed$ BEGIN
PERFORM live.apply_event('storm-upserted', '{
  "liveId": "jma-2622",
  "name": "Fixture",
  "localNames": {"ph": "Ompong", "ja": "台風第22号"},
  "agency": "jma",
  "advisoryNumber": 12,
  "observedAt": "2026-10-20T21:00:00Z",
  "position": [128.4, 15.2],
  "windKt": 95,
  "gustKt": 135,
  "pressureHpa": 940,
  "movement": {"directionDeg": 290, "speedKt": 11},
  "forecast": [
    {"at": "2026-10-21T09:00:00Z", "leadHours": 12, "position": [126.9, 15.8], "windKt": 100, "coneRadiusKm": 70},
    {"at": "2026-10-21T21:00:00Z", "leadHours": 24, "position": [125.3, 16.5], "windKt": 105, "coneRadiusKm": 110},
    {"at": "2026-10-22T21:00:00Z", "leadHours": 48, "position": [122.0, 17.6], "windKt": 85, "coneRadiusKm": 190}
  ],
  "advisoryUrl": "https://www.jma.go.jp/bosai/map.html#contents=typhoon"
}'::jsonb, '2026-10-20T21:30:00Z');
END $seed$;
