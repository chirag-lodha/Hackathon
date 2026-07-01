package server

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"lumina/internal/brivo"
	"lumina/internal/store"
	"lumina/internal/types"
)

// previewNeighbors is how many frames to fetch on each side when a camera is
// opened / scrolled.
const previewNeighbors = 3

// imageRel is the on-disk (and /files) path for a session's image.
func imageRel(sessionID uint, imageID string) string {
	return filepath.ToSlash(filepath.Join("sessions", strconv.FormatUint(uint64(sessionID), 10), "images", imageID+".jpeg"))
}

// saveImageBytes writes preview bytes to the session's image path.
func (s *Server) saveImageBytes(sessionID uint, imageID string, b []byte) (string, error) {
	rel := imageRel(sessionID, imageID)
	abs, err := s.store.Abs(rel)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(abs, b, 0o644); err != nil {
		return "", err
	}
	return rel, nil
}

// downloadPreviewAsync fetches the latest (or ts-anchored) preview in the
// background, driving the image row PROCESSING -> SUCCESS/FAILURE.
func (s *Server) downloadPreviewAsync(img store.Image, authKey string) {
	go func() {
		s.dlSem <- struct{}{}
		defer func() { <-s.dlSem }()

		arch, err := s.brivo.Archiver(authKey, img.CameraESN)
		if err != nil {
			_ = s.repo.ImageFailed(img.ID, err.Error())
			return
		}
		p, err := s.brivo.FetchPreview(authKey, arch, img.CameraESN, img.EENTs, brivo.PrevMode)
		if err != nil {
			_ = s.repo.ImageFailed(img.ID, err.Error())
			return
		}
		rel, err := s.saveImageBytes(img.SessionID, img.ID, p.Bytes)
		if err != nil {
			_ = s.repo.ImageFailed(img.ID, err.Error())
			return
		}
		_ = s.repo.ImageDone(img.ID, rel, p.TS)
		s.captionAsync(img.ID, p.Bytes) // Gemini vision description
	}()
}

// captionAsync asks Gemini to describe a preview frame and stores the result on
// the image row. No-op if the agent isn't configured. Bounded by capSem and
// graceful on error (the UI just shows no caption).
func (s *Server) captionAsync(imageID string, jpeg []byte) {
	if s.agent == nil || !s.agent.Enabled() || len(jpeg) == 0 {
		return
	}
	go func() {
		s.capSem <- struct{}{}
		defer func() { <-s.capSem }()

		_ = s.repo.ImageCaptioning(imageID)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		text, err := s.agent.Describe(ctx, jpeg, "image/jpeg")
		if err != nil || text == "" {
			_ = s.repo.ImageCaptioned(imageID, "", false)
			return
		}
		_ = s.repo.ImageCaptioned(imageID, text, true)
	}()
}

// POST /api/cameras {sessionId, authKey} — list the account's cameras and kick
// off a background download of each camera's latest preview. Returns the
// cameras (each with its imageId) + an esn->imageId map; poll /api/image/status.
func (s *Server) handleCameras(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.verifyCookie(r); !ok {
		writeErr(w, http.StatusUnauthorized, "please log in")
		return
	}
	var req types.CamerasRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	authKey := s.resolveAuthKey(req.AuthKey, req.SessionID)
	if !brivo.IsKey(authKey) {
		writeErr(w, http.StatusBadRequest, "a valid EEN auth key is required")
		return
	}
	sessionID := parseUint(req.SessionID)

	cams, err := s.brivo.Cameras(authKey)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	out := make([]types.Camera, 0, len(cams))
	imgs := make(map[string]string, len(cams))
	for _, cam := range cams {
		id := store.NewUUID()
		img := store.Image{ID: id, SessionID: sessionID, CameraESN: cam.ESN, Kind: "preview", State: store.StateProcessing}
		if err := s.repo.CreateImage(&img); err != nil {
			continue
		}
		s.downloadPreviewAsync(img, authKey) // latest preview (EENTs empty)
		out = append(out, types.Camera{ESN: cam.ESN, Name: cam.Name, Location: cam.Location, Status: cam.Status, ImageID: id})
		imgs[cam.ESN] = id
	}
	writeJSON(w, http.StatusOK, types.CamerasResponse{Cameras: out, Images: imgs})
}

// GET /api/image/status?sessionId=&imageId= — poll a preview download's state.
func (s *Server) handleImageStatus(w http.ResponseWriter, r *http.Request) {
	img, err := s.repo.GetImage(r.URL.Query().Get("imageId"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "image not found")
		return
	}
	writeJSON(w, http.StatusOK, types.ImageStatusResponse{
		ID: img.ID, State: img.State, Ts: img.EENTs, Error: img.Error,
		Caption: img.Caption, CaptionState: img.CaptionState,
	})
}

// GET /api/images?sessionId=&imageId= — serve the downloaded preview JPEG.
func (s *Server) handleServeImage(w http.ResponseWriter, r *http.Request) {
	img, err := s.repo.GetImage(r.URL.Query().Get("imageId"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "image not found")
		return
	}
	if img.State != store.StateSuccess || img.Path == "" {
		writeErr(w, http.StatusAccepted, "image not ready")
		return
	}
	abs, err := s.store.Abs(img.Path)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "bad path")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, abs)
}

// POST /api/previews {sessionId, authKey, cameraEsn, aroundTs, direction, count}
// — fetch N preview frames around a camera's current frame by walking the
// archiver's prev/next links. Each is downloaded + stored immediately (bytes
// come with the walk), so the returned images are already SUCCESS.
func (s *Server) handlePreviews(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.verifyCookie(r); !ok {
		writeErr(w, http.StatusUnauthorized, "please log in")
		return
	}
	var req types.PreviewsRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	authKey := s.resolveAuthKey(req.AuthKey, req.SessionID)
	if !brivo.IsKey(authKey) || req.CameraESN == "" {
		writeErr(w, http.StatusBadRequest, "auth key and cameraEsn are required")
		return
	}
	sessionID := parseUint(req.SessionID)
	n := req.Count
	if n <= 0 {
		n = previewNeighbors
	}

	arch, err := s.brivo.Archiver(authKey, req.CameraESN)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	// store saves one fetched preview, records it as a SUCCESS image, and kicks
	// off a Gemini caption for it.
	store1 := func(p *brivo.Preview) types.Preview {
		id := store.NewUUID()
		rel, err := s.saveImageBytes(sessionID, id, p.Bytes)
		state := store.StateSuccess
		if err != nil {
			state = store.StateFailure
		}
		_ = s.repo.CreateImage(&store.Image{ID: id, SessionID: sessionID, CameraESN: req.CameraESN, EENTs: p.TS, Kind: "preview", State: state, Path: rel})
		if state == store.StateSuccess {
			s.captionAsync(id, p.Bytes)
		}
		return types.Preview{ImageID: id, Ts: p.TS, State: state}
	}

	var previews []types.Preview

	switch req.Direction {
	case "older":
		cur := req.AroundTs
		for i := 0; i < n && cur != ""; i++ {
			p, err := s.brivo.FetchPreview(authKey, arch, req.CameraESN, cur, brivo.PrevMode)
			if err != nil {
				break
			}
			previews = append(previews, store1(p))
			cur = p.PrevTS
		}
	case "newer":
		cur := req.AroundTs
		for i := 0; i < n && cur != ""; i++ {
			p, err := s.brivo.FetchPreview(authKey, arch, req.CameraESN, cur, brivo.NextMode)
			if err != nil {
				break
			}
			previews = append(previews, store1(p))
			cur = p.NextTS
		}
	default: // "around": the anchor + N older + N newer
		anchor, err := s.brivo.FetchPreview(authKey, arch, req.CameraESN, req.AroundTs, brivo.PrevMode)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		previews = append(previews, store1(anchor))
		cur := anchor.PrevTS
		for i := 0; i < n && cur != ""; i++ {
			p, err := s.brivo.FetchPreview(authKey, arch, req.CameraESN, cur, brivo.PrevMode)
			if err != nil {
				break
			}
			previews = append(previews, store1(p))
			cur = p.PrevTS
		}
		cur = anchor.NextTS
		for i := 0; i < n && cur != ""; i++ {
			p, err := s.brivo.FetchPreview(authKey, arch, req.CameraESN, cur, brivo.NextMode)
			if err != nil {
				break
			}
			previews = append(previews, store1(p))
			cur = p.NextTS
		}
	}

	// Sort oldest-first and compute cursor edges.
	sortPreviews(previews)
	resp := types.PreviewsResponse{Previews: previews}
	if len(previews) > 0 {
		resp.OldestTs = previews[0].Ts
		resp.NewestTs = previews[len(previews)-1].Ts
	}
	writeJSON(w, http.StatusOK, resp)
}

func parseUint(s string) uint {
	n, _ := strconv.ParseUint(strings.TrimSpace(s), 10, 64)
	return uint(n)
}

// resolveAuthKey returns the auth key to use: the one supplied in the request if
// present, otherwise the key stored on the session (looked up by id). This lets
// the frontend pass just sessionId — the key lives server-side with the session.
func (s *Server) resolveAuthKey(reqKey, sessionID string) string {
	if k := strings.TrimSpace(reqKey); k != "" {
		return k
	}
	if sess, err := s.repo.GetSession(parseUint(sessionID)); err == nil {
		return sess.AuthKey
	}
	return ""
}

func sortPreviews(p []types.Preview) {
	for i := 1; i < len(p); i++ {
		for j := i; j > 0 && p[j-1].Ts > p[j].Ts; j-- {
			p[j-1], p[j] = p[j], p[j-1]
		}
	}
}
