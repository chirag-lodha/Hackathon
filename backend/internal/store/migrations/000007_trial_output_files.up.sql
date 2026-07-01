-- Record the image files a super-res trial produces: the (optional) ROI crop
-- used as the model input, and the enhanced output. Both are their own images
-- (sessions/<id>/images/<uuid>.png); these columns hold their server-relative
-- paths so the trial links to them explicitly.
ALTER TABLE trials ADD COLUMN roi_crop_filename TEXT NOT NULL DEFAULT '';
ALTER TABLE trials ADD COLUMN output_filename   TEXT NOT NULL DEFAULT '';
