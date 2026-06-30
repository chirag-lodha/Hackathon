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

	// Always include the originally selected frame as the primary view.
	primary, err := imaging.LoadPNG(mustAbs(e.store, srcRel))
	if err != nil {
		return HolisticResult{}, fmt.Errorf("load source: %w", err)
	}
	if roi != nil {
		primary = imaging.Crop(primary, roi.X, roi.Y, roi.W, roi.H)
	}

	camCount := 3 + int(hashByte(esn)%3) // 3..5 cameras
	angles := []string{"Front", "Left 30°", "Right 30°", "Overhead", "Rear"}

	views := []image.Image{enhanceImg(primary, e.cfg.SuperResScale)}
	sources := []types.HolisticSource{{
		ESN:   esn,
		Angle: angles[0],
		Thumb: e.store.URL(srcRel),
	}}

	for i := 1; i < camCount; i++ {
		altESN := fmt.Sprintf("%s%04d", trimESN(esn), int(hashByte(esn+itoa(i)))%9000+1000)
		seed := fmt.Sprintf("%s-alt-%d", esn, i)
		// dummy co-located camera frame; LATER: fetch real frame for altESN.
		var camImg image.Image = imaging.GenerateFrame(seed, 320, 200)
		if roi != nil {
			camImg = imaging.Crop(camImg, roi.X, roi.Y, roi.W, roi.H)
		}
		views = append(views, enhanceImg(camImg, e.cfg.SuperResScale))

		thumbRel := filepath.ToSlash(filepath.Join("outputs", "holsrc-"+seed+".png"))
		_ = imaging.SavePNG(imaging.Resize(camImg, 220, 140), mustAbs(e.store, thumbRel))
		sources = append(sources, types.HolisticSource{
			ESN:   altESN,
			Angle: angles[i%len(angles)],
			Thumb: e.store.URL(thumbRel),
		})
	}

	// Fuse into a single wide composite.
	composite := imaging.Composite(views, 2, 480, 300, 10, colorBG())
	outRel := filepath.ToSlash(filepath.Join("outputs", fmt.Sprintf("holistic-%d.png", time.Now().UnixNano())))
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
