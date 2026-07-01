package hires

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"lumina/internal/imaging"
	"lumina/internal/model"
	"lumina/internal/store"
)

// upscaylTimeout bounds a single Upscayl run so a stuck process can't wedge the
// dispatcher's worker goroutine forever.
const upscaylTimeout = 3 * time.Minute

// sessionIDFromPath extracts <id> from a "sessions/<id>/images/..." path so the
// files a trial produces are recorded against the same session as the source
// frame. Returns 0 if the path isn't in that form.
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

// newImageFile creates a new image row (Postgres assigns the id) and returns it
// with the server-relative path it should be written to: a sibling of the source
// frame named by the generated id (no special prefix), matching the preview
// layout sessions/<id>/images/<uuid>.<ext>.
func (h *HiRes) newImageFile(sessionID uint, esn, kind, dir, ext string) (*store.Image, string, error) {
	img, err := h.repo.CreateImage(&store.Image{SessionID: sessionID, CameraESN: esn, Kind: kind, State: store.StateProcessing})
	if err != nil {
		return nil, "", err
	}
	rel := filepath.ToSlash(filepath.Join(dir, img.ID+ext))
	return img, rel, nil
}

// superRes enhances an already-resolved input frame (the ROI crop, or the source
// frame when there's no ROI) into a NEW tracked output image. It records the
// output on the trial (OutputFilename); the source/crop are never modified.
//
// Enhancement uses the Upscayl CLI, but if Upscayl is unavailable or fails it
// degrades to the built-in sharpen-upscale (dummyEnhance) into the SAME output
// image — so the tracked-image bookkeeping is identical either way.
func (h *HiRes) superRes(trial *store.Trial, inputRel string) (model.SuperResult, error) {
	start := time.Now()

	inAbs, err := h.store.Abs(inputRel)
	if err != nil {
		return model.SuperResult{}, fmt.Errorf("resolve input path: %w", err)
	}
	if _, err := os.Stat(inAbs); err != nil {
		return model.SuperResult{}, fmt.Errorf("input frame missing: %w", err)
	}

	dir := filepath.ToSlash(filepath.Dir(trial.FilePath)) // sessions/<id>/images
	outImg, outRel, err := h.newImageFile(sessionIDFromPath(trial.FilePath), trial.ESN, "output", dir, ".png")
	if err != nil {
		return model.SuperResult{}, fmt.Errorf("create output image: %w", err)
	}
	outAbs, err := h.store.Abs(outRel)
	if err != nil {
		return model.SuperResult{}, err
	}
	if err := os.MkdirAll(filepath.Dir(outAbs), 0o755); err != nil {
		return model.SuperResult{}, err
	}

	scale := h.cfg.SuperResScale
	if scale < 1 {
		scale = 4
	}

	// Enhance with Upscayl, degrading to the built-in upscaler if it fails.
	if err := h.runUpscayl(inAbs, outAbs); err != nil {
		log.Printf("hires: upscayl failed for trial %d, falling back to built-in upscaler: %v", trial.ID, err)
		if derr := dummyEnhance(inAbs, outAbs, scale); derr != nil {
			_ = h.repo.ImageFailed(outImg.ID, derr.Error())
			return model.SuperResult{}, fmt.Errorf("super-res failed (upscayl: %v; fallback: %w)", err, derr)
		}
	}

	// Verify + measure the achieved scale from the actual output pixels.
	out, err := imaging.LoadPNG(outAbs)
	if err != nil {
		_ = h.repo.ImageFailed(outImg.ID, err.Error())
		return model.SuperResult{}, fmt.Errorf("produced no valid output: %w", err)
	}
	_ = h.repo.ImageDone(outImg.ID, outRel, "")
	trial.OutputFilename = outRel

	if in, err := imaging.LoadPNG(inAbs); err == nil {
		if iw := in.Bounds().Dx(); iw > 0 {
			scale = out.Bounds().Dx() / iw
		}
	}

	return model.SuperResult{
		OutputPath: outRel,
		OutputURL:  h.store.URL(outRel),
		SourceURL:  h.store.URL(inputRel),
		Scale:      scale,
		MS:         time.Since(start).Milliseconds(),
	}, nil
}

// runUpscayl shells out to the Upscayl CLI (Real-ESRGAN) to enhance inAbs into
// outAbs: upscayl-bin -i <input> -o <output> -m <models dir> -n <model name>.
func (h *HiRes) runUpscayl(inAbs, outAbs string) error {
	ctx, cancel := context.WithTimeout(context.Background(), upscaylTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, h.cfg.UpscaylBin,
		"-i", inAbs,
		"-o", outAbs,
		"-m", h.cfg.UpscaylModels,
		"-n", h.cfg.UpscaylModel,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, out)
	}
	return nil
}

// dummyEnhance is the built-in fallback super-resolver: it sharpen-upscales inAbs
// by `scale` and writes the result to outAbs. It only reads the input and writes
// the (separate) output — the source frame is never modified.
func dummyEnhance(inAbs, outAbs string, scale int) error {
	if scale < 1 {
		scale = 4
	}
	img, err := imaging.LoadPNG(inAbs) // decodes JPEG previews too
	if err != nil {
		return fmt.Errorf("load %q: %w", inAbs, err)
	}
	b := img.Bounds()
	enhanced := imaging.Enhance(imaging.Resize(img, b.Dx()*scale, b.Dy()*scale), 1.4, 1.18)
	return imaging.SavePNG(enhanced, outAbs)
}
