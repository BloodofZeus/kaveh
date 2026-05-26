package fingerprint

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type JSLeakAPIServer struct {
	m *JSLeakManager
}

func NewJSLeakAPIServer(m *JSLeakManager) *JSLeakAPIServer {
	return &JSLeakAPIServer{m: m}
}

func (s *JSLeakAPIServer) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /fingerprint/jsleak/status", s.handleStatus)
	mux.HandleFunc("POST /fingerprint/jsleak/enable", s.handleEnable)
	mux.HandleFunc("POST /fingerprint/jsleak/disable", s.handleDisable)
}

func (s *JSLeakAPIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.m.Status())
}

func (s *JSLeakAPIServer) handleEnable(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm     bool `json:"confirm"`
		BlockWebRTC bool `json:"block_webrtc"`
		BlockMDNS   bool `json:"block_mdns"`
		BlockQUIC   bool `json:"block_quic"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "invalid json"})
		return
	}
	if !req.Confirm {
		writeJSON(w, http.StatusBadRequest, apiError{Error: "confirm required"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := s.m.Enable(ctx, JSLeakConfig{BlockWebRTC: req.BlockWebRTC, BlockMDNS: req.BlockMDNS, BlockQUIC: req.BlockQUIC}); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, s.m.Status())
}

func (s *JSLeakAPIServer) handleDisable(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	if err := s.m.Disable(ctx); err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, s.m.Status())
}

