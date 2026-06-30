package model

import (
	"fmt"
	"hash/fnv"
	"image"
	"image/color"
	"path/filepath"
	"strings"
	"time"

	"lumina/internal/config"
	"lumina/internal/imaging"
	"lumina/internal/store"
	"lumina/internal/types"
)

// seedFromPath recovers the scene seed from a generated capture path
// "captures/<esn>/<unixMillis>.png" — matching camera.ensureFrame's seed
// (esn-millis). Returns false for any other path (real frames), so the upscaler
// falls back to pixel-based enhancement.
func seedFromPath(rel string) (string, bool) {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) >= 3 && parts[len(parts)-3] == "captures" {
		esn := parts[len(parts)-2]
		ms := strings.TrimSuffix(parts[len(parts)-1], ".png")
		if esn != "" && ms != "" {
			return esn + "-" + ms, true
		}
	}
	return "", false
}

// DummyUpscaler is the stand-in super-resolution model. The low-res source is
// intentionally soft (see camera.ensureFrame), so to simulate genuine detail
// recovery it regenerates the SAME scene at high resolution (crisp) for
// generated frames, or sharpens an upscale of the real pixels otherwise. It
// writes an actual high-res PNG to disk. Replace with a real model by
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
	// The source frame is ALREADY low-res/soft (see camera.ensureFrame), so the
	// "before" is just that same frame — for an ROI we persist the cropped region
	// so the compare shows the same area on both sides, matching the main preview.
	work := src
	sourceRel := srcRel
	if roi != nil && roi.W > 0 && roi.H > 0 {
		work = imaging.Crop(src, roi.X, roi.Y, roi.W, roi.H)
		cropRel := filepath.ToSlash(filepath.Join("outputs", fmt.Sprintf("src-%d.png", time.Now().UnixNano())))
		if absSrc, err := d.store.Abs(cropRel); err == nil {
			if err := imaging.SavePNG(work, absSrc); err == nil {
				sourceRel = cropRel
			}
		}
	}

	// Build the SHARP high-res "after". Dummy stand-in: regenerate the same scene
	// at high resolution (crisp edges) to simulate detail recovery — upscaling the
	// already-soft source pixels would just produce a bigger blur. A real model
	// would infer detail from the input pixels instead.
	srcB := src.Bounds()
	var enhanced image.Image
	if seed, ok := seedFromPath(srcRel); ok {
		hi := imaging.GenerateFrame(seed, srcB.Dx()*scale, srcB.Dy()*scale)
		if roi != nil && roi.W > 0 && roi.H > 0 {
			enhanced = imaging.Crop(hi, roi.X, roi.Y, roi.W, roi.H)
		} else {
			enhanced = hi
		}
	} else {
		// Fallback (non-generated source): sharpen an upscale of the real pixels.
		wb := work.Bounds()
		enhanced = imaging.Enhance(imaging.Resize(work, wb.Dx()*scale, wb.Dy()*scale), 1.4, 1.18)
	}
	eb := enhanced.Bounds()
	outW, outH := eb.Dx(), eb.Dy()

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
		SourceURL:  d.store.URL(sourceRel),
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
