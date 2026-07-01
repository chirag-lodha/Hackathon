package db

import (
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// Trial lifecycle states.
const (
	StateCreated    = "CREATED"
	StateProcessing = "PROCESSING"
	StateSuccess    = "SUCCESS"
	StateFailure    = "FAILURE"
)

// Point is a single normalized [0,1] coordinate.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// JSONB stores raw JSON in a Postgres jsonb column.
type JSONB json.RawMessage

func (j JSONB) Value() (driver.Value, error) {
	if len(j) == 0 {
		return nil, nil
	}
	return []byte(j), nil
}

func (j *JSONB) Scan(src any) error {
	if src == nil {
		*j = nil
		return nil
	}
	switch v := src.(type) {
	case []byte:
		*j = append((*j)[:0], v...)
	case string:
		*j = JSONB(v)
	default:
		return fmt.Errorf("unsupported JSONB source type %T", src)
	}
	return nil
}

// Trial is one enhancement action. Embeds gorm.Model for
// ID / CreatedAt / UpdatedAt / DeletedAt (do not redeclare those).
type Trial struct {
	gorm.Model

	ESN            string `gorm:"column:esn"`
	SessionName    string `gorm:"column:session_name"`
	FilePath       string     `gorm:"column:file_path"` // source (low-res) frame
	FrameTimestamp *time.Time `gorm:"column:frame_timestamp"`
	FrameLabel     string     `gorm:"column:frame_label"`
	Coords         JSONB  `gorm:"column:coords"` // ROI as [{x,y},{x,y}]; null = full frame

	State string `gorm:"column:state"`
	Type  string `gorm:"column:type"` // super_res | holistic

	ResultPath string `gorm:"column:result_path"`
	ResultURL  string `gorm:"column:result_url"`
	SourceURL  string `gorm:"column:source_url"`
	Scale      int    `gorm:"column:scale"`
	Sources    JSONB  `gorm:"column:sources"`
	DurationMS int64  `gorm:"column:duration_ms"`
	Error      string `gorm:"column:error"`
}

// TableName pins the table name (matches the migration).
func (Trial) TableName() string { return "trials" }

// User is an account (username + bcrypt password hash).
type User struct {
	gorm.Model
	Username     string `gorm:"column:username;uniqueIndex"`
	PasswordHash string `gorm:"column:password_hash"`
}

func (User) TableName() string { return "users" }

// Session is a named capture session owned by a user, holding the camera auth
// key (valid 24h — ExpiresAt).
type Session struct {
	gorm.Model
	UserID    uint      `gorm:"column:user_id"`
	Name      string    `gorm:"column:name"`
	AuthKey   string    `gorm:"column:auth_key"`
	ExpiresAt time.Time `gorm:"column:expires_at"`
}

func (Session) TableName() string { return "sessions" }
