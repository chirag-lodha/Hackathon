package model

import (
	"fmt"
	"hash/fnv"
	"image"
	"image/color"
	"path/filepath"
	"time"

	"lumina/internal/config"
	"lumina/internal/imaging"
	"lumina/internal/store"
	"lumina/internal/types"
)

// DummyUpscaler is the stand-in super-resolution model. It performs a real
// load -> (crop) -> upscale -> enhance -> save pipeline so the output is an
// actual high-resolution file on disk. Replace with a real model by
// implementing Upscaler and returning the same SuperResult.
type DummyUpscaler struct {
	cfg   *config.Config
	store *store.Store
}

func (d *DummyUpscaler) Upscale(srcRel string, roi *types.ROI) (SuperResult, error) {
	start := time.Now()
	scale := d.cfg.SuperResScale
	if scale < 1 {
		scale = 4
	}

	abs, err := d.store.Abs(srcRel)
	if err != nil {
		return SuperResult{}, err
	}
	src, err := imaging.LoadPNG(abs)
	if err != nil {
		return SuperResult{}, fmt.Errorf("load source %q: %w", srcRel, err)
	}

	// Crop to ROI first so the enhanced output zooms into the selected region.
	work := src
	if roi != nil && roi.W > 0 && roi.H > 0 {
		work = imaging.Crop(src, roi.X, roi.Y, roi.W, roi.H)
	}

	b := work.Bounds()
	outW, outH := b.Dx()*scale, b.Dy()*scale
	// Cap output so dummy generation stays fast and files stay reasonable.
	const maxW = 1600
	if outW > maxW {
		ratio := float64(maxW) / float64(outW)
		outW = maxW
		outH = int(float64(outH) * ratio)
	}

	upscaled := imaging.Resize(work, outW, outH)
	enhanced := imaging.Enhance(upscaled, 0.6 /*sharpen*/, 1.08 /*contrast*/)

	outRel := filepath.ToSlash(filepath.Join("outputs", fmt.Sprintf("sr-%d.png", time.Now().UnixNano())))
	outAbs, err := d.store.Abs(outRel)
	if err != nil {
		return SuperResult{}, err
	}
	if err := imaging.SavePNG(enhanced, outAbs); err != nil {
		return SuperResult{}, fmt.Errorf("save output: %w", err)
	}

	return SuperResult{
		OutputPath: outRel,
		OutputURL:  d.store.URL(outRel),
		SourceURL:  d.store.URL(srcRel),
		Width:      outW,
		Height:     outH,
		Scale:      scale,
		MS:         time.Since(start).Milliseconds(),
	}, nil
}

// ---------- shared helpers ----------

// enhanceImg upscales + enhances an in-memory image (used by the holistic op).
func enhanceImg(img image.Image, scale int) image.Image {
	if scale < 1 {
		scale = 4
	}
	b := img.Bounds()
	up := imaging.Resize(img, b.Dx()*scale, b.Dy()*scale)
	return imaging.Enhance(up, 0.6, 1.08)
}

func mustAbs(st *store.Store, rel string) string {
	abs, _ := st.Abs(rel)
	return abs
}

func colorBG() color.RGBA { return color.RGBA{12, 12, 22, 255} }

func hashByte(s string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return h.Sum32()
}

func trimESN(esn string) string {
	if len(esn) >= 4 {
		return esn[:4]
	}
	return esn
}

func itoa(i int) string { return fmt.Sprintf("%d", i) }
