package store

import (
	"os"
	"testing"
)

// TestPostgresGeneratesImageID verifies the DB default fills id and GORM returns it.
func TestPostgresGeneratesImageID(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	if err := Migrate(dsn); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	gdb, err := Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	repo := NewRepo(gdb)

	img, err := repo.CreateImage(&Image{SessionID: 1, CameraESN: "TESTESN", Kind: "preview", State: StateProcessing})
	if err != nil {
		t.Fatalf("CreateImage: %v", err)
	}
	if img.ID == "" {
		t.Fatalf("expected Postgres-generated id, got empty string")
	}
	t.Logf("generated id = %q", img.ID)

	got, err := repo.GetImage(img.ID)
	if err != nil {
		t.Fatalf("GetImage(%q): %v", img.ID, err)
	}
	if got.ID != img.ID {
		t.Fatalf("round-trip mismatch: created %q, fetched %q", img.ID, got.ID)
	}
}
