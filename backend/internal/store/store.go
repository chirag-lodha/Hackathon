// Package store is the persistence layer. This file owns the on-disk image
// layout; Postgres access (connection, migrations, models, and the trials
// Repo) lives alongside it in postgres.go / models.go / repo.go.
//
// Layout (under DataDir):
//
//	captures/<esn>/<unixMillis>.png   low-res dummy source frames
//	outputs/<id>.png                  model outputs (super-res / holistic)
//
// Files are exposed to the browser under the /files/ route, so a server path
// "captures/x/y.png" maps to URL "/files/captures/x/y.png".
package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type Store struct {
	dataDir string
}

func New(dataDir string) (*Store, error) {
	s := &Store{dataDir: dataDir}
	for _, d := range []string{
		dataDir,
		filepath.Join(dataDir, "captures"),
		filepath.Join(dataDir, "outputs"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Abs converts a server-relative path (as sent by the client) into an absolute
// filesystem path under DataDir, guarding against path traversal.
func (s *Store) Abs(rel string) (string, error) {
	clean := filepath.Clean("/" + strings.TrimPrefix(rel, "/"))
	abs := filepath.Join(s.dataDir, clean)
	base, _ := filepath.Abs(s.dataDir)
	target, _ := filepath.Abs(abs)
	if !strings.HasPrefix(target, base) {
		return "", errors.New("path escapes data dir")
	}
	return abs, nil
}

// URL maps a server-relative path to a browser-loadable URL.
func (s *Store) URL(rel string) string {
	return "/files/" + strings.TrimPrefix(filepath.ToSlash(rel), "/")
}

// DataDir is the root directory for the /files static handler.
func (s *Store) DataDir() string { return s.dataDir }
