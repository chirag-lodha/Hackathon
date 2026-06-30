// Package db owns the Postgres connection (GORM for queries) and schema
// migrations (golang-migrate with explicit SQL files — NOT gorm AutoMigrate).
package db

import (
	"embed"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres" // registers "postgres" driver
	"github.com/golang-migrate/migrate/v4/source/iofs"
	gormpg "gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// migrationsFS embeds the SQL migration files so the binary is self-contained.
//
//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open connects GORM to Postgres.
func Open(dsn string) (*gorm.DB, error) {
	gdb, err := gorm.Open(gormpg.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	return gdb, nil
}

// Migrate applies all up migrations using the embedded SQL files.
// dsn must be a postgres:// URL understood by golang-migrate.
func Migrate(dsn string) error {
	src, err := iofs.New(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("migration source: %w", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, dsn)
	if err != nil {
		return fmt.Errorf("migrate init: %w", err)
	}
	defer m.Close()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("migrate up: %w", err)
	}
	return nil
}
