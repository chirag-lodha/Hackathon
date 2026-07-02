// Package config centralizes runtime configuration. Everything is overridable
// via environment variables so the same binary runs in dev and prod.
package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// loadDotEnv reads KEY=VALUE lines from a .env file (if present) and sets them
// in the environment, WITHOUT overriding values already set. Keeps secrets like
// GEMINI_API_KEY out of source/commits — put them in backend/.env (gitignored).
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if k != "" && os.Getenv(k) == "" {
			_ = os.Setenv(k, v)
		}
	}
}

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

	// ---- Upscayl (real super-resolution CLI) ----
	// The built-in super-res engine shells out to the Upscayl binary. Paths are
	// overridable so the same build runs where Upscayl is installed elsewhere.
	// UpscaylBin: the upscayl-bin executable.
	// UpscaylModels: the directory holding the .param/.bin model files (-m).
	// UpscaylModel: the model name to run (-n).
	UpscaylBin    string
	UpscaylModels string
	UpscaylModel  string

	// DatabaseURL is the Postgres connection string (postgres://...). The dev
	// default points at the docker-compose service (mapped to host :5433).
	DatabaseURL string

	// ---- Real camera integration (wired later) ----
	// CameraAPIBase is the upstream camera/VMS endpoint that serves frames.
	// AuthKey here is a default; per-request authKey from the UI takes priority.
	CameraAPIBase string
	CameraAuthKey string

	// ---- Brivo AI agent (Google Gemini) ----
	// GeminiAPIKey: free key from Google AI Studio (https://aistudio.google.com).
	// GeminiModel: chat model, e.g. gemini-2.0-flash / gemini-2.5-flash-lite.
	// GeminiCaptionModel: vision model for preview captions — defaults to
	// gemini-2.5-flash-lite (biggest free quota), since captioning is high-volume.
	// GeminiImageModel: image-generation model ("Nano Banana") for the Gemini
	// super-res engine — defaults to gemini-2.5-flash-image.
	GeminiAPIKey       string
	GeminiModel        string
	GeminiCaptionModel string
	GeminiImageModel   string

	// AuthSecret signs the login cookie. Set LUMINA_AUTH_SECRET in production.
	AuthSecret string
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
	loadDotEnv(".env")      // backend/.env when run from backend/
	loadDotEnv("../.env")   // repo-root .env fallback
	dataDir := getenv("LUMINA_DATA_DIR", "data")
	c := &Config{
		Addr:          getenv("LUMINA_ADDR", ":8080"),
		DataDir:       dataDir,
		CapturesDir:   filepath.Join(dataDir, "captures"),
		OutputsDir:    filepath.Join(dataDir, "outputs"),
		FrontendDir:   getenv("LUMINA_FRONTEND_DIR", ""),
		SuperResScale: getenvInt("LUMINA_SR_SCALE", 4),
		UpscaylBin:    getenv("LUMINA_UPSCAYL_BIN", "/opt/Upscayl/resources/bin/upscayl-bin"),
		UpscaylModels: getenv("LUMINA_UPSCAYL_MODELS", "/opt/Upscayl/resources/models"),
		UpscaylModel:  getenv("LUMINA_UPSCAYL_MODEL", "upscayl-standard-4x"),
		DatabaseURL:   getenv("DATABASE_URL", "postgres://lumina:lumina@localhost:5433/lumina?sslmode=disable"),
		CameraAPIBase: getenv("LUMINA_CAMERA_API", ""),
		CameraAuthKey: getenv("LUMINA_CAMERA_AUTHKEY", ""),
		GeminiAPIKey:       getenv("GEMINI_API_KEY", ""),
		GeminiModel:        getenv("GEMINI_MODEL", "gemini-2.0-flash"),
		GeminiCaptionModel: getenv("GEMINI_CAPTION_MODEL", "gemini-2.5-flash-lite"),
		GeminiImageModel:   getenv("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image"),
		AuthSecret:    getenv("LUMINA_AUTH_SECRET", "lumina-dev-secret-change-me"),
	}
	return c
}
