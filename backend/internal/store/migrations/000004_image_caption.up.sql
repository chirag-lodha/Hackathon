-- Gemini vision caption for each preview frame. Generated asynchronously after
-- the image downloads: caption_state goes PROCESSING -> SUCCESS | FAILURE while
-- the caption text lands in `caption`. Empty caption_state = not requested.
ALTER TABLE images ADD COLUMN caption       TEXT NOT NULL DEFAULT '';
ALTER TABLE images ADD COLUMN caption_state TEXT NOT NULL DEFAULT '';
