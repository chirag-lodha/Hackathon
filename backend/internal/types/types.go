// Package types holds the request/response shapes shared across the API.
// These JSON tags MUST match what the React frontend sends and reads
// (see frontend/src/api/client.js and mock.js).
package types

// ROI is a normalized region of interest in [0,1] coordinates, so it can be
// mapped onto the full-resolution source regardless of display size.
type ROI struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// ---------- /api/frames ----------

// FramesRequest is the body posted when opening a session or paging the strip.
type FramesRequest struct {
	SessionName string `json:"sessionName"`
	CameraESN   string `json:"cameraEsn"`
	AnchorTime  string `json:"anchorTime"` // RFC3339; empty => "now"
	AuthKey     string `json:"authKey"`    // optional; used by the real camera API later
	Direction   string `json:"direction"`  // "around" | "left" | "right"
	Cursor      string `json:"cursor"`     // RFC3339 edge timestamp when paging
}

// Frame is a single low-res preview frame.
type Frame struct {
	ID        string `json:"id"`
	Path      string `json:"path"`      // server-relative path used to address the file
	Timestamp string `json:"timestamp"` // RFC3339
	Label     string `json:"label"`     // human-readable "YYYY-MM-DD HH:MM:SS"
	Thumb     string `json:"thumb"`     // URL the browser can load (/files/...)
}

// Cursors mark the earliest/latest timestamps of the returned window so the
// client can request the next set on either side.
type Cursors struct {
	Left  string `json:"left"`
	Right string `json:"right"`
}

type FramesResponse struct {
	Frames      []Frame `json:"frames"`
	Cursors     Cursors `json:"cursors"`
	CameraESN   string  `json:"cameraEsn"`
	SessionName string  `json:"sessionName"`
}

// ---------- /api/super-resolve ----------

type SuperResolveRequest struct {
	ImagePath      string `json:"imagePath"`
	CameraESN      string `json:"cameraEsn"`
	SessionName    string `json:"sessionName"`
	FrameTimestamp string `json:"frameTimestamp"`
	FrameLabel     string `json:"frameLabel"`
	ROI            *ROI   `json:"roi"`    // nil => whole frame
	Engine         string `json:"engine"` // "" | "dummy" | "gemini" (Nano Banana)
}

type SuperResolveResponse struct {
	ID        string `json:"id"`
	Type      string `json:"type"`             // "super_res"
	Engine    string `json:"engine,omitempty"` // which engine is producing it
	State     string `json:"state"`
	ImageURL  string `json:"imageUrl"`
	SourceURL string `json:"sourceUrl"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Scale     int    `json:"scale"`
	ROI       *ROI   `json:"roi"`
	MS        int64  `json:"ms"`
}

// TrialStatusResponse is returned by GET /api/trials/{id} while polling an
// async job. The result fields are populated once State == SUCCESS; Error is
// set on FAILURE.
type TrialStatusResponse struct {
	ID        string           `json:"id"`
	Type      string           `json:"type"`             // "super_res" | "holistic"
	Engine    string           `json:"engine,omitempty"` // "" | "dummy" | "gemini"
	State     string           `json:"state"`            // CREATED | PROCESSING | SUCCESS | FAILURE
	ImageURL  string           `json:"imageUrl,omitempty"`
	SourceURL string           `json:"sourceUrl,omitempty"`
	Scale     int              `json:"scale,omitempty"`
	Sources   []HolisticSource `json:"sources,omitempty"`
	ROI       *ROI             `json:"roi"`
	MS        int64            `json:"ms"`
	Error     string           `json:"error,omitempty"`
}

// ---------- /api/alternate (holistic) ----------

type AlternateRequest struct {
	ImagePath      string `json:"imagePath"`
	CameraESN      string `json:"cameraEsn"`
	SessionName    string `json:"sessionName"`
	FrameTimestamp string `json:"frameTimestamp"`
	FrameLabel     string `json:"frameLabel"`
	ROI            *ROI   `json:"roi"`
}

// HolisticSource describes one contributing camera in the fused view.
type HolisticSource struct {
	ESN   string `json:"esn"`
	Angle string `json:"angle"`
	Thumb string `json:"thumb"`
}

type AlternateResponse struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"` // "holistic"
	State    string           `json:"state"`
	ImageURL string           `json:"imageUrl"`
	Sources  []HolisticSource `json:"sources"`
	ROI      *ROI             `json:"roi"`
	MS       int64            `json:"ms"`
}

// ---------- /api/history ----------

// HistoryRecord is a stored conversion (super-res or holistic) plus metadata.
// It embeds the full result payload so the gallery/lightbox can render offline.
type HistoryRecord struct {
	ID          string           `json:"id"`
	Type        string           `json:"type"` // "super_res" | "holistic"
	State       string           `json:"state"`
	CreatedAt   string           `json:"createdAt"`
	SessionName string           `json:"sessionName"`
	CameraESN   string           `json:"cameraEsn"`
	FramePath   string           `json:"framePath"`
	FrameLabel  string           `json:"frameLabel"`
	ROI         *ROI             `json:"roi"`
	Thumb       string           `json:"thumb"`
	ImageURL    string           `json:"imageUrl"`
	SourceURL   string           `json:"sourceUrl,omitempty"`
	Scale       int              `json:"scale,omitempty"`
	Sources     []HolisticSource `json:"sources,omitempty"`
	MS          int64            `json:"ms"`
}

type HistoryResponse struct {
	Records []HistoryRecord `json:"records"`
}

// ---------- auth & sessions ----------

type AuthRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type AuthResponse struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	IsNew    bool   `json:"isNew"`
}

type CreateSessionRequest struct {
	Name    string `json:"name"`
	AuthKey string `json:"authKey"`
}

type CreateSessionResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ExpiresAt string `json:"expiresAt"`
}

// ---------- cameras + preview images (EEN account via the auth key) ----------

type CamerasRequest struct {
	SessionID string `json:"sessionId"`
	AuthKey   string `json:"authKey"`
}

type Camera struct {
	ESN      string `json:"esn"`
	Name     string `json:"name"`
	Location string `json:"location"`
	Status   string `json:"status"`  // "online" | "offline"
	ImageID  string `json:"imageId"` // uuid of its latest-preview download
}

type CamerasResponse struct {
	Cameras []Camera          `json:"cameras"`
	Images  map[string]string `json:"images"` // esn -> imageId
}

// LocationCamerasRequest asks for every camera that shares the selected camera's
// physical location (EEN "location" field), for the Command View wall.
type LocationCamerasRequest struct {
	SessionID string `json:"sessionId"`
	AuthKey   string `json:"authKey"`
	CameraESN string `json:"cameraEsn"` // the camera whose location we group by
	AroundTs  string `json:"aroundTs"`  // EEN ts to fetch each camera's preview at ("" = latest)
}

// LocationCamerasResponse lists the co-located cameras (each with a preview
// download in flight — poll /api/image/status like the camera grid).
type LocationCamerasResponse struct {
	Location string   `json:"location"`
	Cameras  []Camera `json:"cameras"`
}

// ImageStatusResponse is the poll result for a preview/image download.
type ImageStatusResponse struct {
	ID    string `json:"id"`
	State string `json:"state"` // PROCESSING | SUCCESS | FAILURE
	Ts    string `json:"ts"`    // EEN timestamp (once known)
	Error string `json:"error,omitempty"`
	// Gemini vision caption (filled in async after the image downloads).
	Caption      string `json:"caption,omitempty"`
	CaptionState string `json:"captionState,omitempty"` // "" | PROCESSING | SUCCESS | FAILURE
}

// PreviewsRequest asks for N preview frames around a camera's current frame,
// walking backward/forward from aroundTs (empty = latest).
type PreviewsRequest struct {
	SessionID string `json:"sessionId"`
	AuthKey   string `json:"authKey"`
	CameraESN string `json:"cameraEsn"`
	AroundTs  string `json:"aroundTs"`  // EEN ts to anchor on ("" = latest)
	Direction string `json:"direction"` // "around" | "older" | "newer"
	Count     int    `json:"count"`     // frames per side/direction
}

type Preview struct {
	ImageID string `json:"imageId"`
	Ts      string `json:"ts"` // EEN timestamp
	State   string `json:"state"`
}

type PreviewsResponse struct {
	Previews []Preview `json:"previews"`
	// Cursor timestamps for paging further in each direction.
	OldestTs string `json:"oldestTs"`
	NewestTs string `json:"newestTs"`
}
