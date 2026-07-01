-- Images: preview frames downloaded from the EEN archiver, one row per image.
-- id is a UUID (the image_id handed to the client). state goes
-- PROCESSING -> SUCCESS | FAILURE as the background download runs; the client
-- polls it and then loads the file.
CREATE TABLE images (
    id          TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ,
    session_id  BIGINT NOT NULL,
    camera_esn  TEXT   NOT NULL,
    een_ts      TEXT,                 -- EEN timestamp of the frame
    kind        TEXT   NOT NULL,      -- 'preview'
    state       TEXT   NOT NULL DEFAULT 'PROCESSING',
    path        TEXT,                 -- server-relative file path once downloaded
    error       TEXT
);
CREATE INDEX idx_images_session     ON images (session_id);
CREATE INDEX idx_images_session_cam ON images (session_id, camera_esn);
