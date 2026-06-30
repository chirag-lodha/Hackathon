// Package model is the image-enhancement engine.
//
// Upscaler is the interface a real super-resolution model implements. Today we
// ship DummyUpscaler, which performs a genuine pipeline — load the stored
// low-res file, optionally crop to the ROI, bilinear-upscale by the configured
// factor, apply a light enhance pass, and write the high-res PNG to disk — then
// returns the saved file path/URL. To plug in a real model (Real-ESRGAN, a
// Python microservice, an ONNX runtime, etc.), implement Upscaler and swap it
// in main.go; nothing else changes.
package model

import (
	"fmt"
	"image"
	"path/filepath"
	"time"

	"lumina/internal/config"
	"lumina/internal/imaging"
	"lumina/internal/store"
	"lumina/internal/types"
)

// SuperResult is what the engine returns after enhancing a single frame.
type SuperResult struct {
	OutputPath string // server-relative path to the high-res file
	OutputURL  string
	SourceURL  string // the low-res input, for before/after compare
	Width      int
	Height     int
	Scale      int
	MS         int64
}

// HolisticResult is the fused multi-camera view.
type HolisticResult struct {
	OutputPath string
	OutputURL  string
	Sources    []types.HolisticSource
	MS         int64
}

// Upscaler enhances a low-res frame to high resolution.
type Upscaler interface {
	Upscale(srcRel string, roi *types.ROI) (SuperResult, error)
}

// Engine wires the upscaler to storage + config and adds the holistic op.
type Engine struct {
	cfg   *config.Config
	store *store.Store
	up    Upscaler
}

func NewEngine(cfg *config.Config, st *store.Store) *Engine {
	return &Engine{
		cfg:   cfg,
		store: st,
		up:    &DummyUpscaler{cfg: cfg, store: st},
	}
}

// SuperResolve enhances a single frame (optionally constrained to an ROI).
func (e *Engine) SuperResolve(srcRel string, roi *types.ROI) (SuperResult, error) {
	return e.up.Upscale(srcRel, roi)
}

// Holistic simulates fusing all cameras pointing at the same location into one
// wide, high-res view.
//
// TODAY: derives a few deterministic "co-located" cameras from the ESN,
// enhances each, and composites them into a single image.
//
// LATER: resolve the real set of cameras covering this location (by ESN ->
// site/scene mapping), fetch each one's frame for the same moment, run each
// through the model, and fuse (panorama/stitch or learned multi-view fusion).
func (e *Engine) Holistic(srcRel, esn string, roi *types.ROI) (HolisticResult, error) {
	start := time.Now()
	scale := e.cfg.SuperResScale
	if scale < 1 {
		scale = 4
	}

	// makeHiRes builds a CRISP high-res view for a camera seed (regenerate at
	// high resolution, same approach as super-res), cropped to the ROI if set.
	makeHiRes := func(seed string) image.Image {
		full := imaging.GenerateFrame(seed, 320*scale, 200*scale)
		if roi != nil && roi.W > 0 && roi.H > 0 {
			return imaging.Crop(full, roi.X, roi.Y, roi.W, roi.H)
		}
		return full
	}
	saveView := func(name string, img image.Image) string {
		rel := filepath.ToSlash(filepath.Join("outputs", name))
		_ = imaging.SavePNG(img, mustAbs(e.store, rel))
		return e.store.URL(rel)
	}

	// Dummy: 5 cameras with fixed directions for now. When the real camera API is
	// wired in, this list (count + angles/positions) comes from the upstream
	// response — the frontend already renders whatever sources/angles arrive.
	angles := []string{"Front", "Left 30°", "Right 30°", "Overhead", "Rear"}
	camCount := len(angles) // 5

	// Primary (the selected frame) as a HIGH-RES view. Regenerate from its seed
	// for generated captures; otherwise upscale+enhance the real pixels.
	var primaryHi image.Image
	if seed, ok := seedFromPath(srcRel); ok {
		primaryHi = makeHiRes(seed)
	} else {
		primary, err := imaging.LoadPNG(mustAbs(e.store, srcRel))
		if err != nil {
			return HolisticResult{}, fmt.Errorf("load source: %w", err)
		}
		if roi != nil && roi.W > 0 && roi.H > 0 {
			primary = imaging.Crop(primary, roi.X, roi.Y, roi.W, roi.H)
		}
		primaryHi = enhanceImg(primary, scale)
	}

	ts := time.Now().UnixNano()
	views := []image.Image{primaryHi}
	sources := []types.HolisticSource{{
		ESN:   esn,
		Angle: angles[0],
		Thumb: saveView(fmt.Sprintf("hol-%d-0.png", ts), primaryHi), // high-res
	}}

	for i := 1; i < camCount; i++ {
		altESN := fmt.Sprintf("%s%04d", trimESN(esn), int(hashByte(esn+itoa(i)))%9000+1000)
		seed := fmt.Sprintf("%s-alt-%d", esn, i)
		// dummy co-located camera (crisp high-res); LATER: fetch real frame for altESN.
		hi := makeHiRes(seed)
		views = append(views, hi)
		sources = append(sources, types.HolisticSource{
			ESN:   altESN,
			Angle: angles[i%len(angles)],
			Thumb: saveView(fmt.Sprintf("hol-%d-%d.png", ts, i), hi), // high-res
		})
	}

	// Fuse into a single wide composite (from the high-res views).
	composite := imaging.Composite(views, 2, 480, 300, 10, colorBG())
	outRel := filepath.ToSlash(filepath.Join("outputs", fmt.Sprintf("holistic-%d.png", ts)))
	if err := imaging.SavePNG(composite, mustAbs(e.store, outRel)); err != nil {
		return HolisticResult{}, fmt.Errorf("save holistic: %w", err)
	}

	return HolisticResult{
		OutputPath: outRel,
		OutputURL:  e.store.URL(outRel),
		Sources:    sources,
		MS:         time.Since(start).Milliseconds(),
	}, nil
}
