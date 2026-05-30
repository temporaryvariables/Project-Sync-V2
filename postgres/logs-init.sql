-- Project Sync request logs schema.
-- This lives in a SEPARATE Postgres database from the primary records DB,
-- configured via LOGS_DATABASE_URL on the flight-director-api service.
--
-- flight-director-api creates this automatically on boot and on /reset (the
-- statements are idempotent), so you normally never need to run this by hand.
-- It is kept here for documentation and manual bootstrapping.

-- ---------------------------------------------------------------------------
-- request_logs
-- One row per step of a command's end to end journey, tied together by a
-- correlation_id. Every read and write is scoped by team_id, so a team can
-- only ever see or write its own logs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS request_logs (
    id              BIGSERIAL PRIMARY KEY,
    team_id         TEXT        NOT NULL,
    correlation_id  TEXT        NOT NULL,
    ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
    service         TEXT        NOT NULL,   -- deep-space-network | ground-station-api | rover-relay
    level           TEXT        NOT NULL DEFAULT 'info', -- info | warn | error
    step            TEXT        NOT NULL,   -- e.g. dsn.relay_transmit, station.put, station.throttle
    selector        TEXT,
    station         TEXT,
    http_status     INT,
    latency_ms      INT,
    message         TEXT,
    meta            JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_request_logs_team_corr
    ON request_logs (team_id, correlation_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_team_ts
    ON request_logs (team_id, ts DESC);
