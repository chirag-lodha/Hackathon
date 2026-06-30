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

	"lumina/internal/camera"
	"lumina/internal/config"
	"lumina/internal/db"
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
	if err := db.Migrate(cfg.DatabaseURL); err != nil {
		log.Fatalf("migrations: %v (is Postgres up? `docker compose up -d`)", err)
	}
	gdb, err := db.Open(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	repo := db.NewRepo(gdb)

	cam := camera.New(cfg, st)
	eng := model.NewEngine(cfg, st)
	srv := server.New(cfg, st, cam, eng, repo)

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
