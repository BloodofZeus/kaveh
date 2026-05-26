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
	mux.HandleFunc("GET /dns/interfaces", s.handleInterfaces)
	mux.HandleFunc("POST /dns/flush", s.handleFlush)
	mux.HandleFunc("GET /dns/enforce/status", s.handleEnforceStatus)
	mux.HandleFunc("POST /dns/set", s.handleSet)
	mux.HandleFunc("POST /dns/enforce", s.handleEnforce)
	mux.HandleFunc("POST /dns/unenforce", s.handleUnenforce)
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

func (s *APIServer) handleInterfaces(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	ifaces, err := s.m.Interfaces(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"interfaces": ifaces})
}

func (s *APIServer) handleSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm       bool     `json:"confirm"`
		InterfaceName string   `json:"interface_name"`
		Servers       []string `json:"servers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid json"})
		return
	}
	if !req.Confirm {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "confirm required"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	if err := s.m.SetServers(ctx, req.InterfaceName, req.Servers); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *APIServer) handleEnforceStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.m.EnforceStatus())
}

func (s *APIServer) handleEnforce(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm bool     `json:"confirm"`
		Servers []string `json:"servers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid json"})
		return
	}
	if !req.Confirm {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "confirm required"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	status, err := s.m.Enforce(ctx, req.Servers)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *APIServer) handleUnenforce(w http.ResponseWriter, r *http.Request) {
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

	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	status, err := s.m.Unenforce(ctx)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(v)
}
