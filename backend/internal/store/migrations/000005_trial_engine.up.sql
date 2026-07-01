-- Which engine produced a super-res trial: '' / 'dummy' (built-in sharpen-upscale)
-- or 'gemini' (Gemini 2.5 Flash Image, aka "Nano Banana"). Holistic trials leave it blank.
ALTER TABLE trials ADD COLUMN engine TEXT NOT NULL DEFAULT '';
