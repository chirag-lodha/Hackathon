// Package agent is "Goku" — the conversational brain. It sends the user's
// message + conversation history + current app context to Google Gemini and
// gets back a spoken reply plus a list of UI actions for the frontend to run.
//
// Gemini is asked to return strict JSON ({reply, actions[]}) via responseMimeType.
// The frontend executes the actions (create_session, super_res, holistic, ...).
package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Message struct {
	Role string `json:"role"` // "user" | "model"
	Text string `json:"text"`
}

// Context is the current app state so Goku knows what it can do right now.
type Context struct {
	Route         string `json:"route"`
	HasSession    bool   `json:"hasSession"`
	SessionName   string `json:"sessionName"`
	CameraESN     string `json:"cameraEsn"`
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
	apiKey string
	model  string
	http   *http.Client
}

func New(apiKey, model string) *Agent {
	return &Agent{apiKey: apiKey, model: model, http: &http.Client{Timeout: 30 * time.Second}}
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

Available actions (use only these "type" values):
- "create_session": params {sessionName, cameraEsn, dateTime?}. Starts a session and opens the workspace. dateTime is optional ISO-8601; omit for "now".
- "select_frame": params {position: "first"|"middle"|"last"}. Picks a frame from the strip.
- "set_roi": params {x, y, w, h} all normalized 0..1 (region of interest on the frame).
- "clear_roi": params {}.
- "super_res": params {}. Enhances the selected frame (uses ROI if set).
- "holistic": params {}. Fuses all cameras at the location.
- "super_saiyan": params {}. Shows the holistic fusion as an interactive 3D scene.
- "open_history": params {}. Opens the history gallery.
- "go_home": params {}.

Rules:
- To run super_res/holistic/super_saiyan a frame must be selected; if none is selected, add a select_frame {position:"middle"} action first.
- super_saiyan requires a holistic result; if there is none, you may add a holistic action before it.
- If the user just chats or you need info, return a reply with an empty actions array and ask for what you need (e.g. camera ESN).
- Never invent a camera ESN — ask for it if missing.
- Current app context will be provided; use it to decide what is possible.`

// gemini wire types (minimal)
type geminiPart struct {
	Text string `json:"text"`
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
