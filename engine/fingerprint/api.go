package fingerprint

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type apiError struct {
	Error string `json:"error"`
}

type MacAPIServer struct {
	m *MacManager
}

func NewMacAPIServer(m *MacManager) *MacAPIServer {
	return &MacAPIServer{m: m}
}

func (s *MacAPIServer) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /fingerprint/mac/adapters", s.handleAdapters)
	mux.HandleFunc("POST /fingerprint/mac/spoof", s.handleSpoof)
	mux.HandleFunc("POST /fingerprint/mac/reset", s.handleReset)
}

func (s *MacAPIServer) handleAdapters(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	adapters, err := s.m.ListAdapters(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"adapters": adapters})
}

func (s *MacAPIServer) handleSpoof(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm     bool   `json:"confirm"`
		AdapterName string `json:"adapter_name"`
		Mode        string `json:"mode"`
		Mac         string `json:"mac"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid json"})
		return
	}
	if !req.Confirm {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "confirm required"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	applied, err := s.m.Spoof(ctx, req.AdapterName, req.Mode, req.Mac)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "applied_mac": applied})
}

func (s *MacAPIServer) handleReset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm     bool   `json:"confirm"`
		AdapterName string `json:"adapter_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid json"})
		return
	}
	if !req.Confirm {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "confirm required"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	if err := s.m.Reset(ctx, req.AdapterName); err != nil {
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
