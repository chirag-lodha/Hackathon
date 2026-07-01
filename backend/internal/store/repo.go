package store

import (
	"encoding/json"

	"gorm.io/gorm"

	"lumina/internal/types"
)

// Repo is the data-access layer for trials.
type Repo struct{ db *gorm.DB }

func NewRepo(gdb *gorm.DB) *Repo { return &Repo{db: gdb} }

// CreateTrial inserts a new trial in the CREATED state and returns it.
func (r *Repo) CreateTrial(t *Trial) error {
	if t.State == "" {
		t.State = StateCreated
	}
	return r.db.Create(t).Error
}

// SetState updates only the lifecycle state (CREATED -> PROCESSING -> ...).
func (r *Repo) SetState(id uint, state string) error {
	return r.db.Model(&Trial{}).Where("id = ?", id).Update("state", state).Error
}

// Complete marks a trial SUCCESS and stores its result fields.
func (r *Repo) Complete(t *Trial) error {
	t.State = StateSuccess
	return r.db.Save(t).Error
}

// Fail marks a trial FAILURE with an error message.
func (r *Repo) Fail(id uint, msg string) error {
	return r.db.Model(&Trial{}).Where("id = ?", id).
		Updates(map[string]any{"state": StateFailure, "error": msg}).Error
}

// GetTrial loads a single trial by ID.
func (r *Repo) GetTrial(id uint) (*Trial, error) {
	var t Trial
	if err := r.db.First(&t, id).Error; err != nil {
		return nil, err
	}
	return &t, nil
}

// ListSuccess returns successful trials, newest first (for the history gallery).
func (r *Repo) ListSuccess(limit int) ([]Trial, error) {
	var trials []Trial
	q := r.db.Where("state = ?", StateSuccess).Order("created_at DESC")
	if limit > 0 {
		q = q.Limit(limit)
	}
	err := q.Find(&trials).Error
	return trials, err
}

// ResultPath returns the stored output path for a trial (for file cleanup).
func (r *Repo) ResultPath(id uint) (string, error) {
	var t Trial
	if err := r.db.Select("result_path").First(&t, id).Error; err != nil {
		return "", err
	}
	return t.ResultPath, nil
}

// ResultPaths returns every non-empty output path (for bulk file cleanup).
func (r *Repo) ResultPaths() ([]string, error) {
	var paths []string
	err := r.db.Model(&Trial{}).Where("result_path <> ''").Pluck("result_path", &paths).Error
	return paths, err
}

// HardDeleteByID permanently removes a trial (bypasses soft delete).
func (r *Repo) HardDeleteByID(id uint) error {
	return r.db.Unscoped().Delete(&Trial{}, id).Error
}

// HardDeleteAll permanently removes every trial (hidden admin reset).
func (r *Repo) HardDeleteAll() error {
	return r.db.Unscoped().Where("1 = 1").Delete(&Trial{}).Error
}

// ---------- users & sessions ----------

// FindUser returns the user with the given username, or (nil, nil) if none.
func (r *Repo) FindUser(username string) (*User, error) {
	var u User
	err := r.db.Where("username = ?", username).First(&u).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, nil
		}
		return nil, err
	}
	return &u, nil
}

// CreateUser inserts a new user with an already-hashed password.
func (r *Repo) CreateUser(username, passwordHash string) (*User, error) {
	u := &User{Username: username, PasswordHash: passwordHash}
	if err := r.db.Create(u).Error; err != nil {
		return nil, err
	}
	return u, nil
}

// GetUser loads a user by id.
func (r *Repo) GetUser(id uint) (*User, error) {
	var u User
	if err := r.db.First(&u, id).Error; err != nil {
		return nil, err
	}
	return &u, nil
}

// CreateSession stores a named session (auth key) for a user.
func (r *Repo) CreateSession(s *Session) error {
	return r.db.Create(s).Error
}

// ---------- ROI <-> coords helpers ----------

// CoordsFromROI converts the UI's {x,y,w,h} ROI into the stored two-point
// rectangle form [{x,y},{x,y}] (top-left, bottom-right). Returns nil for no ROI.
func CoordsFromROI(roi *types.ROI) JSONB {
	if roi == nil || roi.W <= 0 || roi.H <= 0 {
		return nil
	}
	pts := []Point{{X: roi.X, Y: roi.Y}, {X: roi.X + roi.W, Y: roi.Y + roi.H}}
	b, _ := json.Marshal(pts)
	return JSONB(b)
}

// ROIFromCoords converts stored two-point coords back to {x,y,w,h}.
func ROIFromCoords(c JSONB) *types.ROI {
	if len(c) == 0 {
		return nil
	}
	var pts []Point
	if err := json.Unmarshal(c, &pts); err != nil || len(pts) < 2 {
		return nil
	}
	x := min(pts[0].X, pts[1].X)
	y := min(pts[0].Y, pts[1].Y)
	return &types.ROI{X: x, Y: y, W: abs(pts[1].X - pts[0].X), H: abs(pts[1].Y - pts[0].Y)}
}

// MarshalSources/UnmarshalSources persist the holistic camera list as JSONB.
func MarshalSources(s []types.HolisticSource) JSONB {
	if len(s) == 0 {
		return nil
	}
	b, _ := json.Marshal(s)
	return JSONB(b)
}

func UnmarshalSources(c JSONB) []types.HolisticSource {
	if len(c) == 0 {
		return nil
	}
	var s []types.HolisticSource
	_ = json.Unmarshal(c, &s)
	return s
}

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}
