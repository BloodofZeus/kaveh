package killswitch

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type apiError struct {
	Error string `json:"error"`
}

type APIServer struct {
	m *Manager
}

func NewAPIServer(m *Manager) *APIServer {
	return &APIServer{m: m}
}

func (s *APIServer) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /killswitch/status", s.handleStatus)
	mux.HandleFunc("POST /killswitch/enable", s.handleEnable)
	mux.HandleFunc("POST /killswitch/disable", s.handleDisable)
}

func (s *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.m.Status())
}

func (s *APIServer) handleEnable(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	if v, ok := body["confirm"].(bool); !ok || !v {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "missing confirm=true"})
		return
	}

	if err := s.m.Enable(ctx); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: sanitizeErr(err.Error())})
		return
	}
	writeJSON(w, http.StatusOK, s.m.Status())
}

func (s *APIServer) handleDisable(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if err := s.m.Disable(ctx); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: sanitizeErr(err.Error())})
		return
	}
	writeJSON(w, http.StatusOK, s.m.Status())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(v)
}

func sanitizeErr(s string) string {
	return strings.TrimSpace(s)
}
