package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"lumina/internal/agent"
	"lumina/internal/hires"
	"lumina/internal/store"
	"lumina/internal/types"
)

// writeJSON encodes v as JSON with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode error: %v", err)
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decode(r *http.Request, v any) error {
	defer r.Body.Close()
	return json.NewDecoder(r.Body).Decode(v)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// POST /api/frames — fetch a ±5s window of preview frames for a camera.
func (s *Server) handleFrames(w http.ResponseWriter, r *http.Request) {
	var req types.FramesRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.CameraESN == "" {
		writeErr(w, http.StatusBadRequest, "cameraEsn is required")
		return
	}

	var anchor, cursor time.Time
	if req.AnchorTime != "" {
		anchor, _ = time.Parse(time.RFC3339, req.AnchorTime)
	}
	if req.Cursor != "" {
		cursor, _ = time.Parse(time.RFC3339, req.Cursor)
	}

	resp, err := s.camera.FetchFrames(req.CameraESN, req.AuthKey, anchor, req.Direction, cursor)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	resp.SessionName = req.SessionName
	writeJSON(w, http.StatusOK, resp)
}

// POST /api/super-resolve — enhance one frame (optionally an ROI) to high-res.
//
// Async: create the trial as CREATED, hand it to the HiRes processor, and
// return 202 immediately. The processor drives the trial through PROCESSING ->
// SUCCESS/FAILURE in the background; the client polls GET /api/trials/{id}.
func (s *Server) handleSuperResolve(w http.ResponseWriter, r *http.Request) {
	var req types.SuperResolveRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.ImagePath == "" {
		writeErr(w, http.StatusBadRequest, "imagePath is required")
		return
	}

	trial := s.newTrial("super_res", req.CameraESN, req.SessionName, req.ImagePath, req.FrameTimestamp, req.FrameLabel, req.ROI)
	if err := s.repo.CreateTrial(trial); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create trial: "+err.Error())
		return
	}

	// Enqueue for background processing (the processor reads imagePath + ROI
	// back from the stored trial by ID).
	s.hires.Submit(&hires.HiRes{TrialID: trial.ID})

	writeJSON(w, http.StatusAccepted, types.SuperResolveResponse{
		ID:    fmt.Sprint(trial.ID),
		Type:  "super_res",
		State: trial.State, // CREATED — poll GET /api/trials/{id} for the result
		ROI:   req.ROI,
	})
}

// GET /api/trials/{id} — poll an async trial's current state and (once ready)
// its result. Used by the client after POST /api/super-resolve returns 202.
func (s *Server) handleTrialStatus(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	t, err := s.repo.GetTrial(uint(id))
	if err != nil {
		writeErr(w, http.StatusNotFound, "trial not found")
		return
	}
	writeJSON(w, http.StatusOK, types.TrialStatusResponse{
		ID:        fmt.Sprint(t.ID),
		Type:      t.Type,
		State:     t.State,
		ImageURL:  t.ResultURL,
		SourceURL: t.SourceURL,
		Scale:     t.Scale,
		Sources:   store.UnmarshalSources(t.Sources),
		ROI:       store.ROIFromCoords(t.Coords),
		MS:        t.DurationMS,
		Error:     t.Error,
	})
}

// POST /api/alternate — build the holistic multi-camera fused view.
func (s *Server) handleAlternate(w http.ResponseWriter, r *http.Request) {
	var req types.AlternateRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.ImagePath == "" {
		writeErr(w, http.StatusBadRequest, "imagePath is required")
		return
	}

	trial := s.newTrial("holistic", req.CameraESN, req.SessionName, req.ImagePath, req.FrameTimestamp, req.FrameLabel, req.ROI)
	if err := s.repo.CreateTrial(trial); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create trial: "+err.Error())
		return
	}
	_ = s.repo.SetState(trial.ID, store.StateProcessing)

	res, err := s.engine.Holistic(req.ImagePath, req.CameraESN, req.ROI)
	if err != nil {
		_ = s.repo.Fail(trial.ID, err.Error())
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	trial.ResultPath = res.OutputPath
	trial.ResultURL = res.OutputURL
	trial.Sources = store.MarshalSources(res.Sources)
	trial.DurationMS = res.MS
	if err := s.repo.Complete(trial); err != nil {
		log.Printf("complete trial %d: %v", trial.ID, err)
	}

	writeJSON(w, http.StatusOK, types.AlternateResponse{
		ID:       fmt.Sprint(trial.ID),
		Type:     "holistic",
		State:    trial.State,
		ImageURL: res.OutputURL,
		Sources:  res.Sources,
		ROI:      req.ROI,
		MS:       res.MS,
	})
}

// POST /api/chat — Goku: send the conversation + app context to Gemini and
// return a spoken reply + UI actions for the frontend to execute.
func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) {
	var req agent.ChatRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	resp, err := s.agent.Chat(r.Context(), req)
	if err != nil {
		// Degrade gracefully: speak the problem rather than failing the UI.
		log.Printf("agent error: %v", err)
		writeJSON(w, http.StatusOK, agent.ChatResponse{Reply: "Sorry, my AI brain had a problem. Please try again.", Actions: nil})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// POST /api/history — return successful trials, newest first.
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	trials, err := s.repo.ListSuccess(200)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	records := make([]types.HistoryRecord, 0, len(trials))
	for _, t := range trials {
		records = append(records, trialToRecord(t))
	}
	writeJSON(w, http.StatusOK, types.HistoryResponse{Records: records})
}

// DELETE /api/trials/{id} — hidden admin: permanently remove one trial + its file.
func (s *Server) handleDeleteTrial(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseUint(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid id")
		return
	}
	if p, err := s.repo.ResultPath(uint(id)); err == nil {
		s.removeFile(p)
	}
	if err := s.repo.HardDeleteByID(uint(id)); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
}

// DELETE /api/trials — hidden admin: wipe all trials + their output files.
func (s *Server) handleDeleteAllTrials(w http.ResponseWriter, r *http.Request) {
	if paths, err := s.repo.ResultPaths(); err == nil {
		for _, p := range paths {
			s.removeFile(p)
		}
	}
	if err := s.repo.HardDeleteAll(); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": "all"})
}

// removeFile deletes an output file by its server-relative path (best effort).
func (s *Server) removeFile(rel string) {
	if rel == "" {
		return
	}
	if abs, err := s.store.Abs(rel); err == nil {
		_ = os.Remove(abs)
	}
}

// newTrial builds a CREATED trial from a request (ROI stored as coords).
func (s *Server) newTrial(typ, esn, session, framePath, frameTS, frameLabel string, roi *types.ROI) *store.Trial {
	t := &store.Trial{
		ESN:         esn,
		SessionName: session,
		FilePath:    framePath,
		FrameLabel:  frameLabel,
		Coords:      store.CoordsFromROI(roi),
		State:       store.StateCreated,
		Type:        typ,
	}
	if frameTS != "" {
		if parsed, err := time.Parse(time.RFC3339, frameTS); err == nil {
			t.FrameTimestamp = &parsed
		}
	}
	return t
}

// trialToRecord maps a stored trial to the history DTO the frontend reads.
func trialToRecord(t store.Trial) types.HistoryRecord {
	return types.HistoryRecord{
		ID:          fmt.Sprint(t.ID),
		Type:        t.Type,
		State:       t.State,
		CreatedAt:   t.CreatedAt.UTC().Format(time.RFC3339),
		SessionName: t.SessionName,
		CameraESN:   t.ESN,
		FramePath:   t.FilePath,
		FrameLabel:  t.FrameLabel,
		ROI:         store.ROIFromCoords(t.Coords),
		Thumb:       t.ResultURL,
		ImageURL:    t.ResultURL,
		SourceURL:   t.SourceURL,
		Scale:       t.Scale,
		Sources:     store.UnmarshalSources(t.Sources),
		MS:          t.DurationMS,
	}
}
