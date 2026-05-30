-- Project Sync database schema.
-- Single shared database. One table per concept. No ORM, plain SQL.

-- ---------------------------------------------------------------------------
-- replication_records
-- The three sources of truth live as columns on a single row, alongside the
-- expected value from the mission log. Synchronization status is computed at
-- write time so the dashboard can read it cheaply.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS replication_records (
    id              BIGSERIAL PRIMARY KEY,
    team_id         TEXT        NOT NULL,
    selector        TEXT        NOT NULL,
    expected_payload TEXT,
    nasa_payload    TEXT,
    esa_payload     TEXT,
    jaxa_payload    TEXT,
    sequence_number BIGINT,
    -- per station sequence numbers (the last sequence each station accepted).
    -- the record level sequence_number above tracks the expected/target order.
    nasa_seq        BIGINT,
    esa_seq         BIGINT,
    jaxa_seq        BIGINT,
    if_match        TEXT,
    -- full_match | partial_match | no_match | null
    expected_status TEXT,
    -- true when all three stations equal the expected payload, else false, null when unknown
    data_in_sync    BOOLEAN,
    -- links the record to the most recent end to end trace for that command
    correlation_id  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (team_id, selector)
);

CREATE INDEX IF NOT EXISTS idx_replication_records_team
    ON replication_records (team_id);
CREATE INDEX IF NOT EXISTS idx_replication_records_team_updated
    ON replication_records (team_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- chaos_rules
-- Each rule targets a station (or all) and optionally a team (or all).
-- mode: blackout | throttle | signal_delay | incorrect_ordering
-- config holds mode specific knobs as JSON.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chaos_rules (
    id          BIGSERIAL PRIMARY KEY,
    -- nasa | esa | jaxa | all
    station     TEXT        NOT NULL DEFAULT 'all',
    -- specific team_id, or null for all teams
    team_id     TEXT,
    mode        TEXT        NOT NULL,
    config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    enabled     BOOLEAN     NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chaos_rules_enabled
    ON chaos_rules (enabled);
