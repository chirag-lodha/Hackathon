// Package imaging provides small, dependency-free image helpers:
// deterministic dummy-frame generation, bilinear resize, crop, a light
// "enhance" pass (sharpen + contrast), and grid compositing for the
// holistic view. All pure standard library so the backend builds offline.
package imaging

import (
	"hash/fnv"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

// palettes for the generated dummy scenes (two-stop gradients).
var palettes = [][2]color.RGBA{
	{{30, 58, 138, 255}, {124, 92, 255, 255}},
	{{15, 118, 110, 255}, {74, 214, 255, 255}},
	{{157, 23, 77, 255}, {249, 115, 22, 255}},
	{{67, 56, 202, 255}, {6, 182, 212, 255}},
	{{124, 45, 18, 255}, {251, 191, 36, 255}},
	{{21, 94, 117, 255}, {163, 230, 53, 255}},
}

func hash32(s string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return h.Sum32()
}

func clampU8(v float64) uint8 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v + 0.5)
}

func lerp(a, b uint8, t float64) uint8 {
	return clampU8(float64(a) + (float64(b)-float64(a))*t)
}

// GenerateFrame renders a deterministic synthetic "camera frame" for a seed.
// Used as the dummy low-res source. detail adds extra structure so a
// high-resolution regeneration could look richer (kept modest here).
func GenerateFrame(seed string, w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	hsh := hash32(seed)
	pal := palettes[hsh%uint32(len(palettes))]

	// diagonal gradient background
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			t := (float64(x)/float64(w) + float64(y)/float64(h)) / 2
			img.SetRGBA(x, y, color.RGBA{
				R: lerp(pal[0].R, pal[1].R, t),
				G: lerp(pal[0].G, pal[1].G, t),
				B: lerp(pal[0].B, pal[1].B, t),
				A: 255,
			})
		}
	}

	// a few deterministic "objects" so frames differ visibly
	for i := 0; i < 7; i++ {
		rx := int(hash32(seed+"x"+itoa(i)) % uint32(w))
		ry := int(hash32(seed+"y"+itoa(i)) % uint32(h))
		rs := int(hash32(seed+"s"+itoa(i))%uint32(w/5)) + w/16
		fillRect(img, rx, ry, rs, rs, color.RGBA{255, 255, 255, 40})
	}
	// central subject block + highlight
	fillRect(img, w*32/100, h*42/100, w*36/100, h*34/100, color.RGBA{0, 0, 0, 64})
	fillCircle(img, w/2, h*40/100, w*7/100, color.RGBA{255, 255, 255, 128})

	return img
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [12]byte
	p := len(b)
	for i > 0 {
		p--
		b[p] = byte('0' + i%10)
		i /= 10
	}
	return string(b[p:])
}

func fillRect(img *image.RGBA, x, y, w, h int, c color.RGBA) {
	for j := y; j < y+h; j++ {
		for i := x; i < x+w; i++ {
			if i >= 0 && j >= 0 && i < img.Bounds().Dx() && j < img.Bounds().Dy() {
				blend(img, i, j, c)
			}
		}
	}
}

func fillCircle(img *image.RGBA, cx, cy, r int, c color.RGBA) {
	for j := cy - r; j <= cy+r; j++ {
		for i := cx - r; i <= cx+r; i++ {
			dx, dy := i-cx, j-cy
			if dx*dx+dy*dy <= r*r && i >= 0 && j >= 0 && i < img.Bounds().Dx() && j < img.Bounds().Dy() {
				blend(img, i, j, c)
			}
		}
	}
}

// blend does simple src-over alpha compositing onto an opaque destination.
func blend(img *image.RGBA, x, y int, c color.RGBA) {
	a := float64(c.A) / 255
	o := img.RGBAAt(x, y)
	img.SetRGBA(x, y, color.RGBA{
		R: clampU8(float64(c.R)*a + float64(o.R)*(1-a)),
		G: clampU8(float64(c.G)*a + float64(o.G)*(1-a)),
		B: clampU8(float64(c.B)*a + float64(o.B)*(1-a)),
		A: 255,
	})
}

// sample returns a clamped pixel as float components.
func sample(src image.Image, b image.Rectangle, x, y int) (r, g, bl float64) {
	if x < b.Min.X {
		x = b.Min.X
	}
	if x >= b.Max.X {
		x = b.Max.X - 1
	}
	if y < b.Min.Y {
		y = b.Min.Y
	}
	if y >= b.Max.Y {
		y = b.Max.Y - 1
	}
	cr, cg, cb, _ := src.At(x, y).RGBA()
	return float64(cr >> 8), float64(cg >> 8), float64(cb >> 8)
}

// Resize performs bilinear interpolation to (dstW, dstH).
func Resize(src image.Image, dstW, dstH int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	for y := 0; y < dstH; y++ {
		fy := (float64(y)+0.5)*float64(sh)/float64(dstH) - 0.5
		y0 := int(math.Floor(fy))
		dy := fy - float64(y0)
		for x := 0; x < dstW; x++ {
			fx := (float64(x)+0.5)*float64(sw)/float64(dstW) - 0.5
			x0 := int(math.Floor(fx))
			dx := fx - float64(x0)

			r00, g00, b00 := sample(src, b, b.Min.X+x0, b.Min.Y+y0)
			r10, g10, b10 := sample(src, b, b.Min.X+x0+1, b.Min.Y+y0)
			r01, g01, b01 := sample(src, b, b.Min.X+x0, b.Min.Y+y0+1)
			r11, g11, b11 := sample(src, b, b.Min.X+x0+1, b.Min.Y+y0+1)

			r := bilerp(r00, r10, r01, r11, dx, dy)
			g := bilerp(g00, g10, g01, g11, dx, dy)
			bb := bilerp(b00, b10, b01, b11, dx, dy)
			dst.SetRGBA(x, y, color.RGBA{clampU8(r), clampU8(g), clampU8(bb), 255})
		}
	}
	return dst
}

func bilerp(c00, c10, c01, c11, dx, dy float64) float64 {
	top := c00 + (c10-c00)*dx
	bot := c01 + (c11-c01)*dx
	return top + (bot-top)*dy
}

// Crop returns the sub-image for a normalized ROI.
func Crop(src image.Image, nx, ny, nw, nh float64) image.Image {
	b := src.Bounds()
	x0 := b.Min.X + int(nx*float64(b.Dx()))
	y0 := b.Min.Y + int(ny*float64(b.Dy()))
	x1 := x0 + int(nw*float64(b.Dx()))
	y1 := y0 + int(nh*float64(b.Dy()))
	rect := image.Rect(x0, y0, x1, y1).Intersect(b)
	if rect.Empty() {
		return src
	}
	// SubImage keeps the original bounds origin; callers treat via Bounds().
	if si, ok := src.(interface {
		SubImage(r image.Rectangle) image.Image
	}); ok {
		return si.SubImage(rect)
	}
	out := image.NewRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
	for y := 0; y < rect.Dy(); y++ {
		for x := 0; x < rect.Dx(); x++ {
			out.Set(x, y, src.At(rect.Min.X+x, rect.Min.Y+y))
		}
	}
	return out
}

// Enhance applies a light unsharp mask + contrast/saturation lift to mimic
// the visual "pop" of a super-resolution model. Stand-in for real inference.
func Enhance(src *image.RGBA, amount, contrast float64) *image.RGBA {
	b := src.Bounds()
	w, hh := b.Dx(), b.Dy()
	out := image.NewRGBA(image.Rect(0, 0, w, hh))
	for y := 0; y < hh; y++ {
		for x := 0; x < w; x++ {
			c := src.RGBAAt(x, y)
			// 4-neighbour blur for the unsharp reference
			br, bg, bb := blurAt(src, x, y)
			r := float64(c.R) + amount*(float64(c.R)-br)
			g := float64(c.G) + amount*(float64(c.G)-bg)
			bl := float64(c.B) + amount*(float64(c.B)-bb)
			// contrast around mid-gray
			r = (r-128)*contrast + 128
			g = (g-128)*contrast + 128
			bl = (bl-128)*contrast + 128
			out.SetRGBA(x, y, color.RGBA{clampU8(r), clampU8(g), clampU8(bl), 255})
		}
	}
	return out
}

func blurAt(img *image.RGBA, x, y int) (r, g, b float64) {
	b0 := img.Bounds()
	var rs, gs, bs, n float64
	for _, d := range [][2]int{{0, 0}, {-1, 0}, {1, 0}, {0, -1}, {0, 1}} {
		xi, yi := x+d[0], y+d[1]
		if xi >= 0 && yi >= 0 && xi < b0.Dx() && yi < b0.Dy() {
			c := img.RGBAAt(xi, yi)
			rs += float64(c.R)
			gs += float64(c.G)
			bs += float64(c.B)
			n++
		}
	}
	return rs / n, gs / n, bs / n
}

// Composite arranges images into a grid (used for the holistic fused view).
func Composite(imgs []image.Image, cols, cellW, cellH, gap int, bg color.RGBA) *image.RGBA {
	if cols < 1 {
		cols = 1
	}
	rows := (len(imgs) + cols - 1) / cols
	w := cols*cellW + (cols+1)*gap
	h := rows*cellH + (rows+1)*gap
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			out.SetRGBA(x, y, bg)
		}
	}
	for i, im := range imgs {
		cell := Resize(im, cellW, cellH)
		ox := gap + (i%cols)*(cellW+gap)
		oy := gap + (i/cols)*(cellH+gap)
		for y := 0; y < cellH; y++ {
			for x := 0; x < cellW; x++ {
				out.SetRGBA(ox+x, oy+y, cell.RGBAAt(x, y))
			}
		}
	}
	return out
}

// SavePNG writes an image to path, creating parent directories.
func SavePNG(img image.Image, path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

// LoadPNG reads a PNG file from disk.
func LoadPNG(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return png.Decode(f)
}
