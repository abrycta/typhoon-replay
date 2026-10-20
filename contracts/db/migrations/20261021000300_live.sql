-- migrate:up

CREATE TABLE live.active_storm (
  live_id           text        PRIMARY KEY CHECK (live_id ~ '^[a-z]+-[a-z0-9-]+$'),
  storm             jsonb       NOT NULL CHECK (jsonb_typeof(storm) = 'object'),
  observed_at       timestamptz NOT NULL,
  position          geography(Point, 4326) NOT NULL,
  updated_seq       bigint      NOT NULL
);
COMMENT ON TABLE live.active_storm IS
  'Current state of each active storm. storm is the ActiveStorm JSON exactly as served (camelCase, no nulls); '
  'observed_at/position are extracted for spatial alert matching. Maintained only through live.apply_event().';
CREATE INDEX active_storm_position_gix ON live.active_storm USING gist (position);

CREATE TABLE live.live_event (
  seq         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type        text        NOT NULL CHECK (type IN ('storm-upserted','storm-removed')),
  live_id     text        NOT NULL,
  payload     jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE live.live_event IS
  'Append-only log behind GET /v1/live/stream. seq is the SSE id: and Last-Event-ID, global across backends, so resume works after switching backend. '
  'payload is the SSE data: JSON (ActiveStorm or StormRemoved). Rows older than 7 days are purged by the maintenance job.';
CREATE INDEX live_event_created_idx ON live.live_event (created_at);

CREATE TABLE live.revision (
  singleton   boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  seq         bigint      NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE live.revision IS
  'Revision counter: the newest live_event.seq applied to live.active_storm. Survives event pruning. '
  'Snapshot id:, LiveSnapshot.seq and the snapshot ETag W/"s{seq}" come from here. Backends poll it (<= 3 s) while a stream client is connected.';
INSERT INTO live.revision (singleton, seq) VALUES (true, 0);

CREATE FUNCTION live.apply_event(p_type text, p_payload jsonb, p_at timestamptz DEFAULT now())
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_live_id text := p_payload ->> 'liveId';
  v_seq     bigint;
BEGIN
  IF v_live_id IS NULL THEN
    RAISE EXCEPTION 'payload.liveId is required' USING ERRCODE = 'check_violation';
  END IF;
  -- Serialise writers so seq order equals commit order (a reader polling seq > last never skips a row).
  PERFORM 1 FROM live.revision WHERE singleton FOR UPDATE;

  INSERT INTO live.live_event (type, live_id, payload, created_at)
  VALUES (p_type, v_live_id, p_payload, p_at)
  RETURNING seq INTO v_seq;

  IF p_type = 'storm-upserted' THEN
    INSERT INTO live.active_storm (live_id, storm, observed_at, position, updated_seq)
    VALUES (
      v_live_id,
      p_payload,
      (p_payload ->> 'observedAt')::timestamptz,
      ST_SetSRID(ST_MakePoint((p_payload #>> '{position,0}')::float8, (p_payload #>> '{position,1}')::float8), 4326)::geography,
      v_seq)
    ON CONFLICT (live_id) DO UPDATE
      SET storm = EXCLUDED.storm, observed_at = EXCLUDED.observed_at,
          position = EXCLUDED.position, updated_seq = EXCLUDED.updated_seq;
  ELSE
    DELETE FROM live.active_storm WHERE live_id = v_live_id;
  END IF;

  UPDATE live.revision SET seq = v_seq, updated_at = p_at WHERE singleton;
  RETURN v_seq;
END
$$;
COMMENT ON FUNCTION live.apply_event(text, jsonb, timestamptz) IS
  'The only write path for live data: appends a live_event, applies it to active_storm and bumps live.revision, atomically. '
  'Used by the ingestion job and by POST /v1/_test/live-events (TR_TEST_HOOKS=1).';

-- migrate:down

DROP FUNCTION live.apply_event(text, jsonb, timestamptz);
DROP TABLE live.revision;
DROP TABLE live.live_event;
DROP TABLE live.active_storm;
