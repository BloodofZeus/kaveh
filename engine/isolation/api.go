package isolation

import (
	"encoding/json"
	"net/http"
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
	mux.HandleFunc("GET /isolation/status", s.handleStatus)
	mux.HandleFunc("PUT /isolation/rules", s.handleSetRules)
	mux.HandleFunc("POST /isolation/enable", s.handleEnable)
	mux.HandleFunc("POST /isolation/disable", s.handleDisable)
}

func (s *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.m.Status())
}

func (s *APIServer) handleSetRules(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Rules []Rule `json:"rules"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid json"})
		return
	}

	if err := s.m.SetRules(req.Rules); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, s.m.Status())
}

func (s *APIServer) handleEnable(w http.ResponseWriter, r *http.Request) {
	if err := s.m.Enable(); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, s.m.Status())
}

func (s *APIServer) handleDisable(w http.ResponseWriter, r *http.Request) {
	if err := s.m.Disable(); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: err.Error()})
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
