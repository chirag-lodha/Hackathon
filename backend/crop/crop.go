// Package crop produces ROI crops of trial source frames as tracked images.
//
// It's deliberately engine-agnostic and standalone (no dependency on the hires
// worker) so any trial flow — Upscayl super-res, Gemini, or a future one — can
// crop a frame to its ROI and get a consistent, tracked "before" image without
// touching the original source frame.
package crop

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"lumina/internal/imaging"
	"lumina/internal/store"
	"lumina/internal/types"
)

// Source crops the trial's source frame to the ROI and saves the crop as its OWN
// tracked image (a sibling of the source under sessions/<id>/images/<uuid>.png;
// the source is never modified). It records the crop on the trial
// (ROICropFilename) and returns the crop's server-relative path.
func Source(repo *store.Repo, st *store.Store, trial *store.Trial, roi *types.ROI) (string, error) {
	inAbs, err := st.Abs(trial.FilePath)
	if err != nil {
		return "", fmt.Errorf("resolve source path: %w", err)
	}
	src, err := imaging.LoadPNG(inAbs) // decodes JPEG previews too
	if err != nil {
		return "", fmt.Errorf("load source %q: %w", trial.FilePath, err)
	}
	cropped := imaging.Crop(src, roi.X, roi.Y, roi.W, roi.H)

	// Create the image row first so Postgres assigns the id, then name the file by it.
	img, err := repo.CreateImage(&store.Image{
		SessionID: sessionIDFromPath(trial.FilePath),
		CameraESN: trial.ESN,
		Kind:      "roi_crop",
		State:     store.StateProcessing,
	})
	if err != nil {
		return "", fmt.Errorf("create ROI crop image: %w", err)
	}
	dir := filepath.ToSlash(filepath.Dir(trial.FilePath)) // sessions/<id>/images
	rel := filepath.ToSlash(filepath.Join(dir, img.ID+".png"))
	abs, err := st.Abs(rel)
	if err != nil {
		return "", err
	}
	if err := imaging.SavePNG(cropped, abs); err != nil {
		_ = repo.ImageFailed(img.ID, err.Error())
		return "", fmt.Errorf("save ROI crop: %w", err)
	}
	_ = repo.ImageDone(img.ID, rel, "")
	trial.ROICropFilename = rel
	return rel, nil
}

// sessionIDFromPath extracts <id> from a "sessions/<id>/images/..." path so the
// crop is recorded against the same session as the source frame. Returns 0 if the
// path isn't in that form.
func sessionIDFromPath(rel string) uint {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	for i, p := range parts {
		if p == "sessions" && i+1 < len(parts) {
			n, _ := strconv.ParseUint(parts[i+1], 10, 64)
			return uint(n)
		}
	}
	return 0
}
