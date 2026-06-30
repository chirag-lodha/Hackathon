-- Trials: one row per enhancement action (super-res or holistic).
-- Columns id/created_at/updated_at/deleted_at match gorm.Model.
-- The record is created as CREATED on submit and its `state` is updated
-- through PROCESSING -> SUCCESS | FAILURE as the model runs.
CREATE TABLE trials (
    id              BIGSERIAL PRIMARY KEY,
    created_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,                 -- gorm soft delete

    esn             TEXT        NOT NULL,        -- camera ESN
    session_name    TEXT,                        -- session label from the UI
    file_path       TEXT        NOT NULL,        -- source (low-res) frame path
    frame_timestamp TIMESTAMPTZ,                 -- timestamp of the source frame
    frame_label     TEXT,                        -- human-readable frame time
    coords          JSONB,                       -- ROI as [{x,y},{x,y}] (normalized); null = full frame

    state           TEXT        NOT NULL DEFAULT 'CREATED',
    type            TEXT        NOT NULL,        -- 'super_res' | 'holistic'

    -- result fields, populated on SUCCESS
    result_path     TEXT,                        -- high-res / holistic output path
    result_url      TEXT,                        -- browser URL for the output
    source_url      TEXT,                        -- browser URL for the source (before/after)
    scale           INTEGER,
    sources         JSONB,                       -- holistic contributing cameras
    duration_ms     BIGINT,
    error           TEXT                         -- populated on FAILURE
);

CREATE INDEX idx_trials_deleted_at ON trials (deleted_at);
CREATE INDEX idx_trials_created_at ON trials (created_at DESC);
CREATE INDEX idx_trials_esn        ON trials (esn);
CREATE INDEX idx_trials_state      ON trials (state);
