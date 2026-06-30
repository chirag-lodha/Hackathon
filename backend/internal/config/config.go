// Package config centralizes runtime configuration. Everything is overridable
// via environment variables so the same binary runs in dev and prod.
package config

import (
	"os"
	"path/filepath"
	"strconv"
)

type Config struct {
	// Addr is the listen address, e.g. ":8080".
	Addr string

	// DataDir holds captures/, outputs/ and history.json.
	DataDir     string
	CapturesDir string
	OutputsDir  string

	// FrontendDir is the built React app (frontend/dist). Served when present
	// so a single binary can host API + UI in production. Empty in dev.
	FrontendDir string

	// SuperResScale is the upscale factor used by the model (e.g. 4 => 4x).
	SuperResScale int

	// DatabaseURL is the Postgres connection string (postgres://...). The dev
	// default points at the docker-compose service (mapped to host :5433).
	DatabaseURL string

	// ---- Real camera integration (wired later) ----
	// CameraAPIBase is the upstream camera/VMS endpoint that serves frames.
	// AuthKey here is a default; per-request authKey from the UI takes priority.
	CameraAPIBase string
	CameraAuthKey string
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getenvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// Load builds a Config from the environment with sensible defaults.
func Load() *Config {
	dataDir := getenv("LUMINA_DATA_DIR", "data")
	c := &Config{
		Addr:          getenv("LUMINA_ADDR", ":8080"),
		DataDir:       dataDir,
		CapturesDir:   filepath.Join(dataDir, "captures"),
		OutputsDir:    filepath.Join(dataDir, "outputs"),
		FrontendDir:   getenv("LUMINA_FRONTEND_DIR", ""),
		SuperResScale: getenvInt("LUMINA_SR_SCALE", 4),
		DatabaseURL:   getenv("DATABASE_URL", "postgres://lumina:lumina@localhost:5433/lumina?sslmode=disable"),
		CameraAPIBase: getenv("LUMINA_CAMERA_API", ""),
		CameraAuthKey: getenv("LUMINA_CAMERA_AUTHKEY", ""),
	}
	return c
}
