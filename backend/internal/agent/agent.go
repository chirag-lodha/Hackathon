// Package agent is "Brivo" — the conversational brain. It sends the user's
// message + conversation history + current app context to Google Gemini and
// gets back a spoken reply plus a list of UI actions for the frontend to run.
//
// Gemini is asked to return strict JSON ({reply, actions[]}) via responseMimeType.
// The frontend executes the actions (create_session, select_camera, super_res, ...).
package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Message struct {
	Role string `json:"role"` // "user" | "model"
	Text string `json:"text"`
}

// Context is the current app state so Brivo knows what it can do right now.
type Context struct {
	Route         string `json:"route"`
	HasSession    bool   `json:"hasSession"`
	SessionName   string `json:"sessionName"`
	HasCamera     bool   `json:"hasCamera"`
	CameraESN     string `json:"cameraEsn"`
	CameraName    string `json:"cameraName"`
	FrameCount    int    `json:"frameCount"`
	FrameSelected bool   `json:"frameSelected"`
	HasResult     bool   `json:"hasResult"`
	Mode          string `json:"mode"`
}

type ChatRequest struct {
	Messages []Message `json:"messages"`
	Context  Context   `json:"context"`
}

type Action struct {
	Type   string         `json:"type"`
	Params map[string]any `json:"params,omitempty"`
}

type ChatResponse struct {
	Reply   string   `json:"reply"`
	Actions []Action `json:"actions"`
}

type Agent struct {
	apiKey       string
	model        string // chat model
	captionModel string // vision model for preview captions
	http         *http.Client
}

func New(apiKey, model, captionModel string) *Agent {
	if captionModel == "" {
		captionModel = model
	}
	return &Agent{apiKey: apiKey, model: model, captionModel: captionModel, http: &http.Client{Timeout: 30 * time.Second}}
}

// Enabled reports whether a Gemini key is configured.
func (a *Agent) Enabled() bool { return a.apiKey != "" }

const systemPrompt = `You are "Brivo", the upbeat voice assistant inside Brivo Lumina, a camera
super-resolution app. Talk like a warm, friendly helper — NOT a robotic chatbot.
Be casual and encouraging, but keep replies SHORT (one or two sentences, spoken
aloud). Proactively suggest the next useful thing, e.g. "Want to see it in the 3D
Super-Saiyan view?" or "Should I pull a crisp high-res preview?". You help an
investigator by understanding natural speech and driving the UI.

Reply MUST be valid JSON of this exact shape:
{"reply": "<short spoken sentence>", "actions": [ {"type": "<action>", "params": { ... }} ]}

Keep "reply" short and conversational (it is spoken aloud). Use 0 or more actions.

The workflow is: create a session (name + account auth key) -> the Cameras grid
loads the account's cameras -> pick a camera to open the Workspace -> select a
frame -> enhance. A "session" is now just a name + auth key; cameras and time are
chosen on the Cameras page, NOT at session creation.

Available actions (use only these "type" values):
- "create_session": params {sessionName, authKey}. Creates the session and opens the Cameras grid. authKey is the account auth key and MUST come from the user — never invent it.
- "open_cameras": params {}. Opens the camera grid for the current session.
- "select_camera": params {cameraEsn, cameraName?, aroundTs?}. Opens that camera's workspace. aroundTs is an optional EEN timestamp (YYYYMMDDhhmmss.fff, UTC); omit for latest.
- "select_frame": params {position: "first"|"middle"|"last"}. Picks a frame from the strip.
- "set_roi": params {x, y, w, h} all normalized 0..1 (region of interest on the frame).
- "clear_roi": params {}.
- "super_res": params {}. Enhances the selected frame (uses ROI if set).
- "holistic": params {}. Fuses all cameras at the location.
- "super_saiyan": params {}. Shows the holistic fusion as an interactive 3D scene.
- "open_history": params {}. Opens the history gallery.
- "go_home": params {}.

Rules:
- create_session needs an auth key from the user; if you don't have it, ask for it (empty actions).
- select_camera needs a camera ESN; the available cameras are shown on the grid — ask the user which one if unsure. Never invent an ESN.
- To run super_res/holistic/super_saiyan a frame must be selected; if none is selected, add a select_frame {position:"middle"} action first.
- super_saiyan requires a holistic result; if there is none, you may add a holistic action before it.
- If the user just chats or you need info, return a reply with an empty actions array and ask for what you need.
- Current app context will be provided; use it to decide what is possible.`

// captionPrompt asks Gemini to describe a single surveillance frame in one line.
const captionPrompt = `You are analyzing ONE still frame from a security/surveillance camera.
In a single concise sentence (max ~18 words), describe what is visible — people,
vehicles, notable objects, and the general scene. Be factual and specific; do not
guess identities. If the frame is blank, black, or too dark/blurry to read, say
"No clear scene — the frame is dark or empty." Reply with the sentence only, no preamble.`

// gemini wire types (minimal)
type geminiBlob struct {
	MIMEType string `json:"mimeType"`
	Data     string `json:"data"` // base64
}
type geminiPart struct {
	Text       string      `json:"text,omitempty"`
	InlineData *geminiBlob `json:"inlineData,omitempty"`
}
type geminiContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []geminiPart `json:"parts"`
}
type geminiReq struct {
	SystemInstruction *geminiContent  `json:"systemInstruction,omitempty"`
	Contents          []geminiContent `json:"contents"`
	GenerationConfig  map[string]any  `json:"generationConfig,omitempty"`
}
type geminiResp struct {
	Candidates []struct {
		Content geminiContent `json:"content"`
	} `json:"candidates"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// Chat runs one turn through Gemini and returns the parsed reply + actions.
func (a *Agent) Chat(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	if !a.Enabled() {
		return ChatResponse{Reply: "My AI brain isn't configured yet. Please set a Gemini API key.", Actions: nil}, nil
	}

	ctxJSON, _ := json.Marshal(req.Context)
	sys := systemPrompt + "\n\nCurrent app context (JSON): " + string(ctxJSON)

	contents := make([]geminiContent, 0, len(req.Messages))
	for _, m := range req.Messages {
		role := m.Role
		if role != "model" {
			role = "user"
		}
		contents = append(contents, geminiContent{Role: role, Parts: []geminiPart{{Text: m.Text}}})
	}

	body := geminiReq{
		SystemInstruction: &geminiContent{Parts: []geminiPart{{Text: sys}}},
		Contents:          contents,
		GenerationConfig: map[string]any{
			"responseMimeType": "application/json",
			"temperature":      0.3,
		},
	}
	buf, _ := json.Marshal(body)

	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s", a.model, a.apiKey)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return ChatResponse{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	res, err := a.http.Do(httpReq)
	if err != nil {
		return ChatResponse{}, fmt.Errorf("gemini request: %w", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)

	var gr geminiResp
	if err := json.Unmarshal(raw, &gr); err != nil {
		return ChatResponse{}, fmt.Errorf("gemini decode: %w", err)
	}
	if gr.Error != nil {
		return ChatResponse{}, fmt.Errorf("gemini error: %s", gr.Error.Message)
	}
	if len(gr.Candidates) == 0 || len(gr.Candidates[0].Content.Parts) == 0 {
		return ChatResponse{Reply: "Sorry, I didn't get that. Could you say it again?"}, nil
	}

	// The model returns JSON text (responseMimeType=application/json).
	out := gr.Candidates[0].Content.Parts[0].Text
	var parsed ChatResponse
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		// Fallback: treat the raw text as a plain spoken reply.
		return ChatResponse{Reply: out}, nil
	}
	return parsed, nil
}

// Describe sends an image to Gemini vision and returns a one-line description of
// what is visible in the frame. mimeType is e.g. "image/jpeg".
func (a *Agent) Describe(ctx context.Context, img []byte, mimeType string) (string, error) {
	if !a.Enabled() {
		return "", fmt.Errorf("agent not configured")
	}
	if mimeType == "" {
		mimeType = "image/jpeg"
	}

	body := geminiReq{
		Contents: []geminiContent{{
			Role: "user",
			Parts: []geminiPart{
				{Text: captionPrompt},
				{InlineData: &geminiBlob{MIMEType: mimeType, Data: base64.StdEncoding.EncodeToString(img)}},
			},
		}},
		GenerationConfig: map[string]any{"temperature": 0.2},
	}
	buf, _ := json.Marshal(body)

	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s", a.captionModel, a.apiKey)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	res, err := a.http.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("gemini vision request: %w", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)

	var gr geminiResp
	if err := json.Unmarshal(raw, &gr); err != nil {
		return "", fmt.Errorf("gemini vision decode: %w", err)
	}
	if gr.Error != nil {
		return "", fmt.Errorf("gemini vision error: %s", gr.Error.Message)
	}
	if len(gr.Candidates) == 0 || len(gr.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("gemini vision: empty response")
	}
	// Join all text parts (thinking models may emit a thought part before the answer).
	var sb strings.Builder
	for _, p := range gr.Candidates[0].Content.Parts {
		if p.Text != "" {
			sb.WriteString(p.Text)
		}
	}
	return strings.TrimSpace(sb.String()), nil
}
