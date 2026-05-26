package monitor

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
	mux.HandleFunc("GET /monitor/connections", s.handleSnapshot)
	mux.HandleFunc("GET /monitor/blocks", s.handleBlocksStatus)
	mux.HandleFunc("POST /monitor/block", s.handleBlock)
	mux.HandleFunc("POST /monitor/unblock", s.handleUnblock)
	mux.HandleFunc("POST /monitor/clear_blocks", s.handleClearBlocks)
}

func (s *APIServer) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	snap, err := s.m.Snapshot(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

func (s *APIServer) handleBlocksStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.m.BlocksStatus())
}

func (s *APIServer) handleBlock(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm  bool   `json:"confirm"`
		RemoteIP string `json:"remote_ip"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid json"})
		return
	}
	if !req.Confirm {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "confirm required"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.m.BlockIP(ctx, req.RemoteIP); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, s.m.BlocksStatus())
}

func (s *APIServer) handleUnblock(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm  bool   `json:"confirm"`
		RemoteIP string `json:"remote_ip"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid json"})
		return
	}
	if !req.Confirm {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "confirm required"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.m.UnblockIP(ctx, req.RemoteIP); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, s.m.BlocksStatus())
}

func (s *APIServer) handleClearBlocks(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm bool `json:"confirm"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid json"})
		return
	}
	if !req.Confirm {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "confirm required"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := s.m.ClearBlocks(ctx); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, s.m.BlocksStatus())
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(v)
}
