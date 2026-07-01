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
	"bytes"
	"context"
	"fmt"
	"image"
	"os"
	"path/filepath"
	"strings"
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

// ImageGenerator turns an input image + instruction into a new image. Gemini's
// image model ("Nano Banana") implements this; kept as an interface so the model
// package doesn't import the agent package directly (wired in main.go).
type ImageGenerator interface {
	ImageEnabled() bool
	GenerateImage(ctx context.Context, img []byte, mime, prompt string) (out []byte, outMime string, err error)
}

// Engine wires the upscaler to storage + config and adds the holistic op.
type Engine struct {
	cfg      *config.Config
	store    *store.Store
	up       Upscaler
	imageGen ImageGenerator // optional; enables the Gemini super-res engine
}

func NewEngine(cfg *config.Config, st *store.Store) *Engine {
	return &Engine{
		cfg:   cfg,
		store: st,
		up:    &DummyUpscaler{cfg: cfg, store: st},
	}
}

// SetImageGenerator wires in the Gemini image generator (Nano Banana).
func (e *Engine) SetImageGenerator(g ImageGenerator) { e.imageGen = g }

// GeminiAvailable reports whether the Gemini super-res engine can be used.
func (e *Engine) GeminiAvailable() bool { return e.imageGen != nil && e.imageGen.ImageEnabled() }

// SuperResolve enhances a single frame (optionally constrained to an ROI).
func (e *Engine) SuperResolve(srcRel string, roi *types.ROI) (SuperResult, error) {
	return e.up.Upscale(srcRel, roi)
}

// geminiPrompt instructs the image model to upscale/restore the frame.
const geminiPrompt = `Enhance this security-camera frame into a sharp, high-resolution, richly detailed photograph. ` +
	`Recover fine detail and reduce noise/blur, but keep the EXACT same scene, framing, perspective, objects and people. ` +
	`Do not add, remove, or invent anything that is not already present. Output only the enhanced image.`

// GeminiEnhance runs the Gemini image model ("Nano Banana") on a frame (optionally
// cropped to the ROI) and saves the returned high-res image. Returns an error (so
// the trial fails cleanly) if Gemini is unconfigured or the call fails.
func (e *Engine) GeminiEnhance(srcRel string, roi *types.ROI) (SuperResult, error) {
	if !e.GeminiAvailable() {
		return SuperResult{}, fmt.Errorf("Gemini image engine is not configured")
	}
	start := time.Now()

	abs, err := e.store.Abs(srcRel)
	if err != nil {
		return SuperResult{}, err
	}
	src, err := imaging.LoadPNG(abs)
	if err != nil {
		return SuperResult{}, fmt.Errorf("load source %q: %w", srcRel, err)
	}

	// Crop to the ROI first so Gemini enhances (and we compare) the same region.
	work := src
	sourceRel := srcRel
	if roi != nil && roi.W > 0 && roi.H > 0 {
		work = imaging.Crop(src, roi.X, roi.Y, roi.W, roi.H)
		cropRel := filepath.ToSlash(filepath.Join("outputs", fmt.Sprintf("src-%d.png", time.Now().UnixNano())))
		if absSrc, err := e.store.Abs(cropRel); err == nil {
			if err := imaging.SavePNG(work, absSrc); err == nil {
				sourceRel = cropRel
			}
		}
	}

	inBytes, err := imaging.PNGBytes(work)
	if err != nil {
		return SuperResult{}, fmt.Errorf("encode source: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Second)
	defer cancel()
	outBytes, outMime, err := e.imageGen.GenerateImage(ctx, inBytes, "image/png", geminiPrompt)
	if err != nil {
		return SuperResult{}, err
	}

	ext := ".png"
	if strings.Contains(outMime, "jpeg") || strings.Contains(outMime, "jpg") {
		ext = ".jpg"
	}
	outRel := filepath.ToSlash(filepath.Join("outputs", fmt.Sprintf("gemini-%d%s", time.Now().UnixNano(), ext)))
	outAbs, err := e.store.Abs(outRel)
	if err != nil {
		return SuperResult{}, err
	}
	if err := os.MkdirAll(filepath.Dir(outAbs), 0o755); err != nil {
		return SuperResult{}, err
	}
	if err := os.WriteFile(outAbs, outBytes, 0o644); err != nil {
		return SuperResult{}, fmt.Errorf("save output: %w", err)
	}

	// Report the scale relative to the (possibly cropped) input, when decodable.
	outW, outH, scale := 0, 0, 0
	if img, _, derr := image.Decode(bytes.NewReader(outBytes)); derr == nil {
		b := img.Bounds()
		outW, outH = b.Dx(), b.Dy()
		if wb := work.Bounds(); wb.Dx() > 0 {
			scale = outW / wb.Dx()
		}
	}

	return SuperResult{
		OutputPath: outRel,
		OutputURL:  e.store.URL(outRel),
		SourceURL:  e.store.URL(sourceRel),
		Width:      outW,
		Height:     outH,
		Scale:      scale,
		MS:         time.Since(start).Milliseconds(),
	}, nil
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
