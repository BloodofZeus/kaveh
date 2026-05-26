package dns

import (
	"context"
	"encoding/json"
	"net/http"
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
	mux.HandleFunc("GET /dns/status", s.handleStatus)
	mux.HandleFunc("POST /dns/flush", s.handleFlush)
}

func (s *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	status, err := s.m.Status(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *APIServer) handleFlush(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	if err := s.m.Flush(ctx); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(v)
}
