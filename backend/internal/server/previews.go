package server

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"lumina/internal/agent"
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

// captionInterval spaces out Gemini vision calls to stay under the free-tier
// rate limit (~20 requests/min for flash models). ~4s => ~15/min.
const captionInterval = 4 * time.Second

// maxCaptionAttempts bounds how many times a rate-limited caption is retried.
const maxCaptionAttempts = 3

// captionAsync queues a preview frame for a Gemini vision description. No-op if
// the agent isn't configured. Enqueue is non-blocking; if the queue is full the
// job is dropped (the UI just shows no caption).
func (s *Server) captionAsync(imageID string, jpeg []byte) {
	if s.agent == nil || !s.agent.Enabled() || len(jpeg) == 0 {
		return
	}
	_ = s.repo.ImageCaptioning(imageID)
	select {
	case s.capQueue <- captionJob{imageID: imageID, jpeg: jpeg}:
	default:
		log.Printf("caption queue full, dropping %s", imageID)
		_ = s.repo.ImageCaptioned(imageID, "", false)
	}
}

// captionWorker drains the caption queue one job at a time, rate-limited, so a
// burst of previews never trips the Gemini free-tier RPM limit.
func (s *Server) captionWorker() {
	var last time.Time
	for job := range s.capQueue {
		if wait := captionInterval - time.Since(last); wait > 0 {
			time.Sleep(wait)
		}
		last = time.Now()
		s.runCaption(job)
	}
}

func (s *Server) runCaption(job captionJob) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	text, err := s.agent.Describe(ctx, job.jpeg, "image/jpeg")
	if err == nil && text != "" {
		_ = s.repo.ImageCaptioned(job.imageID, text, true)
		return
	}

	// Retry transient errors (quota/rate-limit AND model-overload "high demand")
	// by re-queueing after a bounded delay, so captions that lost the race still land.
	if err != nil && isRetryable(err) && job.attempt+1 < maxCaptionAttempts {
		delay := retryDelay(err)
		job.attempt++
		log.Printf("caption %s transient error, retry %d in %s: %v", job.imageID, job.attempt, delay, err)
		go func() {
			time.Sleep(delay)
			select {
			case s.capQueue <- job:
			default:
				_ = s.repo.ImageCaptioned(job.imageID, "", false)
			}
		}()
		return
	}

	if err != nil {
		log.Printf("caption %s failed: %v", job.imageID, err)
	}
	_ = s.repo.ImageCaptioned(job.imageID, "", false)
}

// isRetryable reports whether a Gemini error is transient — a quota/rate-limit
// hit or a temporary model-overload ("high demand") / 5xx — and worth retrying.
func isRetryable(err error) bool {
	m := strings.ToLower(err.Error())
	for _, s := range []string{"quota", "rate limit", "429", "exceeded", "high demand", "try again later", "overloaded", "unavailable", "503", "500", "internal error"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// retryDelay picks how long to wait before retrying: the API-suggested "retry in
// Xs" for rate limits (clamped), else a short backoff for transient overloads.
func retryDelay(err error) time.Duration {
	m := err.Error()
	if i := strings.Index(m, "retry in "); i >= 0 {
		rest := m[i+len("retry in "):]
		if end := strings.IndexAny(rest, "s "); end > 0 {
			if secs, perr := strconv.ParseFloat(rest[:end], 64); perr == nil && secs > 0 {
				d := time.Duration(secs*float64(time.Second)) + time.Second
				if d > 90*time.Second {
					d = 90 * time.Second
				}
				return d
			}
		}
	}
	return 8 * time.Second // transient overload backoff
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

// POST /api/location-cameras {sessionId, cameraEsn, aroundTs} — return every
// camera sharing the selected camera's physical location (EEN "location" field)
// and kick off a preview download for each at the given moment. Powers the
// Command View wall: "show me all cameras covering this location right now".
func (s *Server) handleLocationCameras(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.verifyCookie(r); !ok {
		writeErr(w, http.StatusUnauthorized, "please log in")
		return
	}
	var req types.LocationCamerasRequest
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

	cams, err := s.brivo.Cameras(authKey)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	// The selected camera's EEN location — used as a human label and as the
	// fallback grouping if visual grouping isn't available.
	var location string
	for _, c := range cams {
		if c.ESN == req.CameraESN {
			location = c.Location
			break
		}
	}

	// Primary path: let Gemini VISION decide which cameras show the same physical
	// place (the EEN location label can be coarse — every camera on one account may
	// share it). We grab each camera's frame, ask Gemini to cluster them, and keep
	// the group containing the selected camera. Falls back to the location label.
	if out, grp := s.groupByScene(authKey, sessionID, req.CameraESN, req.AroundTs, cams); len(out) > 0 {
		writeJSON(w, http.StatusOK, types.LocationCamerasResponse{Location: firstNonEmpty(grp, location), Cameras: out})
		return
	}

	// Fallback: group by the EEN location field (async downloads).
	out := make([]types.Camera, 0)
	for _, cam := range cams {
		sameLocation := location != "" && cam.Location == location
		isSelf := cam.ESN == req.CameraESN
		if !sameLocation && !isSelf {
			continue
		}
		id := store.NewUUID()
		img := store.Image{ID: id, SessionID: sessionID, CameraESN: cam.ESN, EENTs: req.AroundTs, Kind: "preview", State: store.StateProcessing}
		if err := s.repo.CreateImage(&img); err != nil {
			continue
		}
		s.downloadPreviewAsync(img, authKey)
		out = append(out, types.Camera{ESN: cam.ESN, Name: cam.Name, Location: cam.Location, Status: cam.Status, ImageID: id})
	}

	writeJSON(w, http.StatusOK, types.LocationCamerasResponse{Location: location, Cameras: out})
}

// groupByScene fetches every camera's frame, asks Gemini to cluster the ones that
// show the same physical place, and returns the cameras in the selected camera's
// group (previews already downloaded → SUCCESS images). Returns nil if Gemini is
// unavailable/fails, so the caller falls back to location-label grouping. The
// second return is a short human label for the group.
func (s *Server) groupByScene(authKey string, sessionID uint, selectedESN, aroundTs string, cams []brivo.Camera) ([]types.Camera, string) {
	if s.agent == nil || !s.agent.Enabled() {
		return nil, ""
	}

	// Fetch each camera's frame concurrently (bounded by dlSem).
	type shot struct {
		cam brivo.Camera
		p   *brivo.Preview
	}
	shots := make([]shot, len(cams))
	var wg sync.WaitGroup
	for i, cam := range cams {
		wg.Add(1)
		go func(i int, cam brivo.Camera) {
			defer wg.Done()
			s.dlSem <- struct{}{}
			defer func() { <-s.dlSem }()
			arch, err := s.brivo.Archiver(authKey, cam.ESN)
			if err != nil {
				return
			}
			if p, err := s.brivo.FetchPreview(authKey, arch, cam.ESN, aroundTs, brivo.PrevMode); err == nil {
				shots[i] = shot{cam: cam, p: p}
			}
		}(i, cam)
	}
	wg.Wait()

	var items []agent.SceneImage
	for _, sh := range shots {
		if sh.p != nil && len(sh.p.Bytes) > 0 {
			items = append(items, agent.SceneImage{ESN: sh.cam.ESN, JPEG: sh.p.Bytes})
		}
	}
	if len(items) == 0 {
		return nil, ""
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	groups, err := s.agent.GroupByScene(ctx, items)
	if err != nil {
		log.Printf("command-view scene grouping failed, falling back to location: %v", err)
		return nil, ""
	}

	// Find the group containing the selected camera.
	var group map[string]bool
	for _, g := range groups {
		for _, esn := range g {
			if esn == selectedESN {
				group = make(map[string]bool, len(g))
				for _, e := range g {
					group[e] = true
				}
				break
			}
		}
		if group != nil {
			break
		}
	}
	if group == nil {
		return nil, "" // Gemini didn't place the selected camera → fall back
	}

	// Build the response from the selected group, saving the frames we already have.
	out := make([]types.Camera, 0, len(group))
	for _, sh := range shots {
		if sh.p == nil || !group[sh.cam.ESN] {
			continue
		}
		id := store.NewUUID()
		rel, serr := s.saveImageBytes(sessionID, id, sh.p.Bytes)
		state := store.StateSuccess
		if serr != nil {
			state = store.StateFailure
		}
		_ = s.repo.CreateImage(&store.Image{ID: id, SessionID: sessionID, CameraESN: sh.cam.ESN, EENTs: sh.p.TS, Kind: "preview", State: state, Path: rel})
		out = append(out, types.Camera{ESN: sh.cam.ESN, Name: sh.cam.Name, Location: sh.cam.Location, Status: sh.cam.Status, ImageID: id})
	}
	return out, "" // label left blank → caller uses the EEN location string
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
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
		// Resolve the anchor first to step PAST it, so paging returns genuinely
		// older frames (not the cursor frame the client already has).
		anchor, err := s.brivo.FetchPreview(authKey, arch, req.CameraESN, req.AroundTs, brivo.PrevMode)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		cur := anchor.PrevTS
		for i := 0; i < n && cur != ""; i++ {
			p, err := s.brivo.FetchPreview(authKey, arch, req.CameraESN, cur, brivo.PrevMode)
			if err != nil {
				break
			}
			previews = append(previews, store1(p))
			cur = p.PrevTS
		}
	case "newer":
		anchor, err := s.brivo.FetchPreview(authKey, arch, req.CameraESN, req.AroundTs, brivo.NextMode)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		cur := anchor.NextTS
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
