package fingerprint

import (
	"context"
	"errors"
	"sync"
	"time"
)

type JSLeakConfig struct {
	BlockWebRTC bool `json:"block_webrtc"`
	BlockMDNS   bool `json:"block_mdns"`
	BlockQUIC   bool `json:"block_quic"`
}

type JSLeakStatus struct {
	Enabled   bool        `json:"enabled"`
	Supported bool        `json:"supported"`
	Config    JSLeakConfig `json:"config"`
	Since     *time.Time  `json:"since,omitempty"`
}

type JSLeakManager struct {
	mu        sync.Mutex
	supported bool
	enabled   bool
	cfg       JSLeakConfig
	since     *time.Time
}

func NewJSLeakManager() *JSLeakManager {
	return &JSLeakManager{
		supported: jsLeakSupported(),
		cfg: JSLeakConfig{
			BlockWebRTC: true,
			BlockMDNS:   true,
			BlockQUIC:   false,
		},
	}
}

func (m *JSLeakManager) Status() JSLeakStatus {
	m.mu.Lock()
	defer m.mu.Unlock()

	return JSLeakStatus{
		Enabled:   m.enabled,
		Supported: m.supported,
		Config:    m.cfg,
		Since:     m.since,
	}
}

func (m *JSLeakManager) Enable(ctx context.Context, cfg JSLeakConfig) error {
	m.mu.Lock()
	supported := m.supported
	m.mu.Unlock()

	if !supported {
		return errors.New("js leak protection not supported on this platform")
	}

	if err := jsLeakApplyRules(ctx, cfg); err != nil {
		return err
	}

	now := time.Now().UTC()
	m.mu.Lock()
	m.enabled = true
	m.cfg = cfg
	m.since = &now
	m.mu.Unlock()

	return nil
}

func (m *JSLeakManager) Disable(ctx context.Context) error {
	m.mu.Lock()
	supported := m.supported
	m.mu.Unlock()

	if !supported {
		return errors.New("js leak protection not supported on this platform")
	}

	if err := jsLeakDisableRules(ctx); err != nil {
		return err
	}

	m.mu.Lock()
	m.enabled = false
	m.since = nil
	m.mu.Unlock()
	return nil
}

