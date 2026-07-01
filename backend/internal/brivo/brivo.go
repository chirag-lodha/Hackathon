// Package brivo is the Eagle Eye Networks pipeline: a small, reusable client for
// the account API. Everything is derived from the auth key (a legacy session
// cookie "cXXX~..."): the cluster host from its prefix, and the auth_key cookie
// on every request.
//
// Capabilities:
//   - Cameras(authKey)                 → the account's cameras (ESN, name, ...)
//   - Archiver(authKey, esn)           → the healthiest archiver IP (cached)
//   - FetchPreview(.., esn, ts, mode)  → a preview JPEG + its/neighbor timestamps
//
// Preview navigation uses the archiver's /asset/prev and /asset/next endpoints,
// which return the image plus x-ee-timestamp / x-ee-prev / x-ee-next headers —
// so we can walk frames without fragile time-window queries.
package brivo

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	TimeLayout = "20060102150405.000" // EEN timestamp format (UTC)
	healthBase = "http://dproxy.test.eencloud.com"
)

// PrevMode / NextMode select the walk direction for FetchPreview.
const (
	PrevMode = "prev" // preview at-or-before ts (use with ts="" for the latest)
	NextMode = "next" // preview at-or-after ts
)

type Client struct {
	hc     *http.Client
	mu     sync.Mutex
	arches map[string]archEntry // esn -> healthiest archiver (cached)
}

type archEntry struct {
	ip  string
	exp time.Time
}

func New() *Client {
	return &Client{hc: &http.Client{Timeout: 25 * time.Second}, arches: map[string]archEntry{}}
}

// IsKey reports whether an auth key looks like an EEN session cookie.
func IsKey(authKey string) bool { return strings.Contains(authKey, "~") }

// clusterBase derives "https://cXXX.eagleeyenetworks.com" from the key prefix.
func clusterBase(authKey string) string {
	if i := strings.IndexByte(authKey, '~'); i > 0 {
		return "https://" + authKey[:i] + ".eagleeyenetworks.com"
	}
	return ""
}

func (c *Client) get(rawurl, authKey string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, rawurl, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Cookie", "auth_key="+authKey)
	return c.hc.Do(req)
}

// Now returns the current time in EEN format.
func Now() string { return time.Now().UTC().Format(TimeLayout) }

// ParseTS parses an EEN timestamp (UTC). Zero time on error.
func ParseTS(s string) time.Time { t, _ := time.Parse(TimeLayout, s); return t }

// ---------- cameras ----------

type Camera struct {
	ESN      string
	Name     string
	Location string
	Status   string
}

func (c *Client) Cameras(authKey string) ([]Camera, error) {
	base := clusterBase(authKey)
	if base == "" {
		return nil, fmt.Errorf("not an EEN auth key")
	}
	resp, err := c.get(base+"/g/device/list", authKey)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("device list: HTTP %d", resp.StatusCode)
	}
	var rows [][]any
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return nil, fmt.Errorf("decode device list: %w", err)
	}
	cams := make([]Camera, 0, len(rows))
	for _, r := range rows {
		if len(r) < 4 {
			continue
		}
		if typ, _ := r[3].(string); typ != "camera" {
			continue
		}
		esn, _ := r[1].(string)
		if esn == "" {
			continue
		}
		name, _ := r[2].(string)
		cams = append(cams, Camera{ESN: esn, Name: name, Location: rowLocation(r), Status: "online"})
	}
	return cams, nil
}

func rowLocation(r []any) string {
	if len(r) > 21 {
		if la, ok := r[21].([]any); ok {
			if len(la) > 6 {
				if s, ok := la[6].(string); ok && s != "" {
					return s
				}
			}
			if len(la) > 4 {
				if s, ok := la[4].(string); ok && s != "" {
					return s
				}
			}
		}
	}
	if len(r) > 16 {
		if s, ok := r[16].(string); ok {
			return s
		}
	}
	return ""
}

// ---------- archiver health ----------

// Archiver returns the healthiest archiver IP for a camera (cached ~5 min).
func (c *Client) Archiver(authKey, esn string) (string, error) {
	c.mu.Lock()
	if e, ok := c.arches[esn]; ok && time.Now().Before(e.exp) {
		c.mu.Unlock()
		return e.ip, nil
	}
	c.mu.Unlock()

	u := fmt.Sprintf("%s/api/v2/dhash/node/v2/com.eencloud.dhash.esn:%s:archiver/health", healthBase, esn)
	resp, err := c.get(u, authKey)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("archiver health: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Data struct {
			Value struct {
				Archivers []struct {
					IP    string  `json:"ip"`
					Score float64 `json:"score"`
				} `json:"archivers"`
			} `json:"value"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode health: %w", err)
	}
	best, bestScore := "", -1.0
	for _, a := range out.Data.Value.Archivers {
		if a.Score > bestScore {
			best, bestScore = a.IP, a.Score
		}
	}
	if best == "" {
		return "", fmt.Errorf("no archivers for %s", esn)
	}
	c.mu.Lock()
	c.arches[esn] = archEntry{ip: best, exp: time.Now().Add(5 * time.Minute)}
	c.mu.Unlock()
	return best, nil
}

// ---------- preview images ----------

// Preview is a fetched preview image plus its timestamp and neighbors.
type Preview struct {
	Bytes  []byte
	TS     string // this frame's EEN timestamp
	PrevTS string // the frame before it ("" if none)
	NextTS string // the frame after it  ("" if none)
}

// FetchPreview downloads one preview from the archiver. mode is PrevMode
// (at-or-before ts) or NextMode (at-or-after ts). Pass ts="" with PrevMode to
// get the latest available preview.
func (c *Client) FetchPreview(authKey, archiver, esn, ts, mode string) (*Preview, error) {
	if ts == "" {
		ts = Now()
	}
	u := fmt.Sprintf("http://%s/asset/%s/image.jpeg?id=%s&timestamp=%s&asset_class=pre",
		archiver, mode, url.QueryEscape(esn), ts)
	resp, err := c.get(u, authKey)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("preview %s@%s: HTTP %d", esn, ts, resp.StatusCode)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return &Preview{
		Bytes:  b,
		TS:     cleanTS(resp.Header.Get("x-ee-timestamp")),
		PrevTS: cleanTS(resp.Header.Get("x-ee-prev")),
		NextTS: cleanTS(resp.Header.Get("x-ee-next")),
	}, nil
}

// cleanTS strips the "preview-" prefix and treats "unknown" as empty.
func cleanTS(h string) string {
	h = strings.TrimPrefix(h, "preview-")
	if h == "" || h == "unknown" {
		return ""
	}
	return h
}
