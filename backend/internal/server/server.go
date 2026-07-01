// Package server wires the HTTP routes, middleware, and static file serving.
package server

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"lumina/internal/agent"
	"lumina/internal/brivo"
	"lumina/internal/camera"
	"lumina/internal/config"
	"lumina/internal/hires"
	"lumina/internal/model"
	"lumina/internal/store"
)

type Server struct {
	cfg    *config.Config
	store  *store.Store
	camera *camera.Client
	engine *model.Engine
	repo   *store.Repo
	agent  *agent.Agent
	hires  *hires.Processor
	brivo  *brivo.Client
	dlSem  chan struct{} // bounds concurrent preview downloads
}

func New(cfg *config.Config, st *store.Store, cam *camera.Client, eng *model.Engine, repo *store.Repo, ag *agent.Agent, hp *hires.Processor, bv *brivo.Client) *Server {
	return &Server{cfg: cfg, store: st, camera: cam, engine: eng, repo: repo, agent: ag, hires: hp, brivo: bv, dlSem: make(chan struct{}, 12)}
}

// Handler builds the full http.Handler (routes + middleware).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// API (method-aware routing, Go 1.22+).
	mux.HandleFunc("POST /api/frames", s.handleFrames)
	mux.HandleFunc("POST /api/super-resolve", s.handleSuperResolve)
	mux.HandleFunc("GET /api/trials/{id}", s.handleTrialStatus)
	mux.HandleFunc("POST /api/alternate", s.handleAlternate)
	mux.HandleFunc("POST /api/history", s.handleHistory)
	mux.HandleFunc("DELETE /api/trials/{id}", s.handleDeleteTrial)
	mux.HandleFunc("DELETE /api/trials", s.handleDeleteAllTrials)
	mux.HandleFunc("POST /api/chat", s.handleChat)
	mux.HandleFunc("POST /api/auth", s.handleAuth)
	mux.HandleFunc("GET /api/me", s.handleMe)
	mux.HandleFunc("POST /api/logout", s.handleLogout)
	mux.HandleFunc("POST /api/sessions", s.handleCreateSession)
	mux.HandleFunc("POST /api/cameras", s.handleCameras)
	mux.HandleFunc("POST /api/previews", s.handlePreviews)
	mux.HandleFunc("GET /api/image/status", s.handleImageStatus)
	mux.HandleFunc("GET /api/images", s.handleServeImage)
	mux.HandleFunc("GET /api/health", s.handleHealth)

	// Static: generated/processed images.
	fileServer := http.FileServer(http.Dir(s.store.DataDir()))
	mux.Handle("GET /files/", http.StripPrefix("/files/", noCacheImages(fileServer)))

	// Frontend (production single-binary mode). In dev this is empty and the
	// Vite server hosts the UI while proxying /api and /files here.
	if s.cfg.FrontendDir != "" {
		mux.Handle("GET /", s.spaHandler(s.cfg.FrontendDir))
	}

	return logging(cors(mux))
}

// ---------- middleware ----------

// cors allows the dev frontend (and any direct callers) to reach the API.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(sw, r)
		log.Printf("%s %s -> %d (%s)", r.Method, r.URL.Path, sw.status, time.Since(start))
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func noCacheImages(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Outputs are content-addressed by nanos; captures are stable. Allow caching.
		w.Header().Set("Cache-Control", "public, max-age=86400")
		next.ServeHTTP(w, r)
	})
}

// spaHandler serves built assets and falls back to index.html for client routes.
func (s *Server) spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean(r.URL.Path))
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	})
}
