package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"lumina/internal/db"
	"lumina/internal/types"
)

const (
	cookieName = "lumina_auth"
	loginTTL   = 7 * 24 * time.Hour // stay logged in for a week
	sessionTTL = 24 * time.Hour     // the camera auth-key session lives 24h
)

// signUID makes a tamper-evident cookie value: "<uid>.<hmac>".
func (s *Server) signUID(uid uint) string {
	raw := strconv.FormatUint(uint64(uid), 10)
	mac := hmac.New(sha256.New, []byte(s.cfg.AuthSecret))
	mac.Write([]byte(raw))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return raw + "." + sig
}

// verifyCookie returns the user id if the cookie is present and valid.
func (s *Server) verifyCookie(r *http.Request) (uint, bool) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return 0, false
	}
	parts := strings.SplitN(c.Value, ".", 2)
	if len(parts) != 2 {
		return 0, false
	}
	mac := hmac.New(sha256.New, []byte(s.cfg.AuthSecret))
	mac.Write([]byte(parts[0]))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(parts[1])) {
		return 0, false
	}
	uid, err := strconv.ParseUint(parts[0], 10, 64)
	if err != nil {
		return 0, false
	}
	return uint(uid), true
}

func (s *Server) setAuthCookie(w http.ResponseWriter, uid uint) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    s.signUID(uid),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(loginTTL.Seconds()),
	})
}

// POST /api/auth — signup if the username is new, else login (verify password).
func (s *Server) handleAuth(w http.ResponseWriter, r *http.Request) {
	var req types.AuthRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || req.Password == "" {
		writeErr(w, http.StatusBadRequest, "username and password are required")
		return
	}

	existing, err := s.repo.FindUser(req.Username)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	var user *db.User
	isNew := false
	if existing == nil {
		// signup
		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "hash error")
			return
		}
		user, err = s.repo.CreateUser(req.Username, string(hash))
		if err != nil {
			writeErr(w, http.StatusConflict, "could not create user")
			return
		}
		isNew = true
	} else {
		// login
		if bcrypt.CompareHashAndPassword([]byte(existing.PasswordHash), []byte(req.Password)) != nil {
			writeErr(w, http.StatusUnauthorized, "incorrect password")
			return
		}
		user = existing
	}

	s.setAuthCookie(w, user.ID)
	writeJSON(w, http.StatusOK, types.AuthResponse{
		UserID:   fmt.Sprint(user.ID),
		Username: user.Username,
		IsNew:    isNew,
	})
}

// GET /api/me — who is logged in (restores auth on refresh).
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	uid, ok := s.verifyCookie(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "not logged in")
		return
	}
	user, err := s.repo.GetUser(uid)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "not logged in")
		return
	}
	writeJSON(w, http.StatusOK, types.AuthResponse{UserID: fmt.Sprint(user.ID), Username: user.Username})
}

// POST /api/logout — clear the cookie.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// POST /api/sessions — store a named session (camera auth key) for the logged-in
// user; the auth key session is valid for 24h.
func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	uid, ok := s.verifyCookie(r)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "please log in")
		return
	}
	var req types.CreateSessionRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || strings.TrimSpace(req.AuthKey) == "" {
		writeErr(w, http.StatusBadRequest, "session name and auth key are required")
		return
	}

	sess := &db.Session{
		UserID:    uid,
		Name:      req.Name,
		AuthKey:   strings.TrimSpace(req.AuthKey),
		ExpiresAt: time.Now().Add(sessionTTL),
	}
	if err := s.repo.CreateSession(sess); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, types.CreateSessionResponse{
		ID:        fmt.Sprint(sess.ID),
		Name:      sess.Name,
		ExpiresAt: sess.ExpiresAt.UTC().Format(time.RFC3339),
	})
}
