// Command lumina is the Brivo Lumina backend: it serves preview frames,
// runs the (dummy) super-resolution + holistic model, stores results on disk,
// and exposes everything over a small JSON API consumed by the React frontend.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"lumina/internal/agent"
	"lumina/internal/brivo"
	"lumina/internal/camera"
	"lumina/internal/config"
	"lumina/internal/hires"
	"lumina/internal/model"
	"lumina/internal/server"
	"lumina/internal/store"
)

func main() {
	cfg := config.Load()

	st, err := store.New(cfg.DataDir)
	if err != nil {
		log.Fatalf("store init: %v", err)
	}

	// Run schema migrations (golang-migrate) then connect GORM.
	if err := store.Migrate(cfg.DatabaseURL); err != nil {
		log.Fatalf("migrations: %v (is Postgres up? `docker compose up -d`)", err)
	}
	gdb, err := store.Open(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	repo := store.NewRepo(gdb)

	cam := camera.New(cfg, st)
	eng := model.NewEngine(cfg, st)
	ag := agent.New(cfg.GeminiAPIKey, cfg.GeminiModel, cfg.GeminiCaptionModel)
	if ag.Enabled() {
		log.Printf("Brivo agent enabled (chat: %s, caption: %s)", cfg.GeminiModel, cfg.GeminiCaptionModel)
	} else {
		log.Printf("Brivo agent disabled (set GEMINI_API_KEY to enable)")
	}

	// HiRes background processor: start its dispatcher goroutine, then hand it
	// to the server so handlers can Submit trials for async processing.
	hp := hires.New(eng, repo)
	hp.Init()

	bv := brivo.New() // Eagle Eye Networks pipeline (cameras + previews)

	srv := server.New(cfg, st, cam, eng, repo, ag, hp, bv)

	httpServer := &http.Server{
		Addr:              cfg.Addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      60 * time.Second, // model ops can take a moment
		IdleTimeout:       120 * time.Second,
	}

	// Start in a goroutine so we can wait for shutdown signals.
	go func() {
		log.Printf("Brivo Lumina backend listening on %s (data: %s)", cfg.Addr, cfg.DataDir)
		if cfg.FrontendDir != "" {
			log.Printf("serving frontend from %s", cfg.FrontendDir)
		}
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	// Graceful shutdown on SIGINT/SIGTERM.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	log.Println("stopped")
}
