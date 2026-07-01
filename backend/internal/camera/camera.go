// Package camera is the source of preview/low-res frames.
//
// TODAY: a dummy generator synthesizes deterministic frames on disk for any
// (ESN, timestamp), so the whole pipeline is testable without hardware.
//
// LATER: Fetch* will call the real camera/VMS API using the camera ESN and an
// auth key to pull the actual recorded frames for the ±5s window. The handler
// signatures and return shapes are designed so only the body of fetchFrame /
// ensureFrame changes — nothing upstream needs to.
package camera

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"lumina/internal/config"
	"lumina/internal/imaging"
	"lumina/internal/store"
	"lumina/internal/types"
)

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// fps and windowSeconds define the ±5s window. 2 fps => ~21 frames per set.
const (
	fps           = 2
	windowSeconds = 5
	lowResW       = 320
	lowResH       = 200
)

type Client struct {
	cfg   *config.Config
	store *store.Store
}

func New(cfg *config.Config, st *store.Store) *Client {
	return &Client{cfg: cfg, store: st}
}

// FetchFrames returns one ±5s set of synthesized (dummy) frames for the given
// camera — used for non-EEN test keys. Real EEN previews come from the brivo
// pipeline via /api/cameras + /api/previews.
//
// direction:
//   - "around": centered on anchor (or now if anchor is zero)
//   - "left":   the set immediately BEFORE cursor
//   - "right":  the set immediately AFTER cursor
func (c *Client) FetchFrames(esn, authKey string, anchor time.Time, direction string, cursor time.Time) (types.FramesResponse, error) {
	if esn == "" {
		return types.FramesResponse{}, fmt.Errorf("camera ESN is required")
	}
	_ = authKey

	total := windowSeconds*2*fps + 1 // 21
	step := time.Second / fps

	// Determine the timestamp of the first frame in the set.
	var first time.Time
	switch direction {
	case "left":
		// the set ending just before the cursor
		first = cursor.Add(-time.Duration(total) * step)
	case "right":
		first = cursor.Add(step)
	default: // "around"
		base := anchor
		if base.IsZero() {
			base = time.Now()
		}
		first = base.Add(-time.Duration(windowSeconds*fps) * step)
	}

	frames := make([]types.Frame, 0, total)
	for i := 0; i < total; i++ {
		t := first.Add(time.Duration(i) * step)
		f, err := c.ensureFrame(esn, t)
		if err != nil {
			return types.FramesResponse{}, err
		}
		frames = append(frames, f)
	}

	return types.FramesResponse{
		Frames: frames,
		Cursors: types.Cursors{
			Left:  frames[0].Timestamp,
			Right: frames[len(frames)-1].Timestamp,
		},
		CameraESN: esn,
	}, nil
}

// ensureFrame returns frame metadata, generating + caching the dummy image on
// disk if it does not already exist. (LATER: download real frame bytes here.)
func (c *Client) ensureFrame(esn string, t time.Time) (types.Frame, error) {
	ms := t.UnixMilli()
	rel := filepath.ToSlash(filepath.Join("captures", esn, fmt.Sprintf("%d.png", ms)))
	abs, err := c.store.Abs(rel)
	if err != nil {
		return types.Frame{}, err
	}

	if !fileExists(abs) {
		seed := fmt.Sprintf("%s-%d", esn, ms)
		// Soften so the stored frame looks genuinely low-res. The SAME capture is
		// used for the filmstrip, the main stage preview, and the super-res
		// "before" — so all previews are consistent and only the enhanced output
		// looks sharp. (Dummy stand-in for a real low-res camera frame.)
		img := imaging.Blur(imaging.GenerateFrame(seed, lowResW, lowResH), 2)
		if err := imaging.SavePNG(img, abs); err != nil {
			return types.Frame{}, err
		}
	}

	return types.Frame{
		ID:        fmt.Sprintf("%s-%d", esn, ms),
		Path:      rel,
		Timestamp: t.UTC().Format(time.RFC3339),
		Label:     t.UTC().Format("2006-01-02 15:04:05"),
		Thumb:     c.store.URL(rel),
	}, nil
}
