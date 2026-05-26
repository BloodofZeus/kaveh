package isolation

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

type Rule struct {
	PID       int    `json:"pid"`
	CircuitID string `json:"circuit_id"`
	ProxyAddr string `json:"proxy_addr"`
	Enforced  bool   `json:"enforced"`
	LastError string `json:"last_error,omitempty"`
}

type Status struct {
	Enabled   bool   `json:"enabled"`
	Supported bool   `json:"supported"`
	Backend   string `json:"backend"`
	Rules     []Rule `json:"rules"`
}

type Manager struct {
	mu      sync.Mutex
	enabled bool
	rules   []Rule

	supported bool
	backend   string

	diverter *winDivertDiverter
	sessions map[int]*pidSession
}

func NewManager() *Manager {
	winDivertPresent := detectWinDivertPresence()
	backend := "firewall"
	if winDivertPresent {
		backend = "windivert"
	}

	supported := runtime.GOOS == "windows"
	diverter := newWinDivertDiverter()
	return &Manager{
		enabled:   false,
		rules:     nil,
		supported: supported,
		backend:   backend,
		diverter:  diverter,
		sessions:  map[int]*pidSession{},
	}
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()

	rules := make([]Rule, len(m.rules))
	copy(rules, m.rules)

	return Status{
		Enabled:   m.enabled,
		Supported: m.supported,
		Backend:   m.backend,
		Rules:     rules,
	}
}

func (m *Manager) SetRules(rules []Rule) error {
	for _, r := range rules {
		if r.PID <= 0 {
			return errors.New("pid must be > 0")
		}
		if r.CircuitID == "" {
			return errors.New("circuit_id is required")
		}
		if r.ProxyAddr == "" {
			return errors.New("proxy_addr is required")
		}
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	next := make([]Rule, len(rules))
	copy(next, rules)
	m.rules = next

	if m.enabled {
		if m.backend == "windivert" {
			m.stopAllSessionsLocked()
			m.startSessionsLocked()
		} else if m.backend == "firewall" {
			go m.applyFirewallIfNeeded()
		}
	}
	return nil
}

func (m *Manager) Enable() error {
	if !m.supported {
		return errors.New("isolation not supported on this platform")
	}

	m.mu.Lock()
	if m.enabled {
		m.mu.Unlock()
		return nil
	}
	backend := m.backend
	rules := make([]Rule, len(m.rules))
	copy(rules, m.rules)
	m.mu.Unlock()

	if backend == "firewall" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		next, err := enforceFirewallRules(ctx, rules)
		m.mu.Lock()
		m.rules = next
		if err == nil {
			m.enabled = true
		}
		m.mu.Unlock()
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if !detectWinDivertPresence() {
		return errors.New("windivert backend not installed")
	}
	m.startSessionsLocked()
	if len(m.sessions) == 0 && len(m.rules) > 0 {
		return errors.New("failed to start windivert sessions")
	}
	m.enabled = true
	return nil
}

func (m *Manager) Disable() error {
	m.mu.Lock()
	if !m.enabled {
		m.mu.Unlock()
		return nil
	}
	backend := m.backend
	m.enabled = false
	m.mu.Unlock()

	if backend == "firewall" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = disableFirewallRules(ctx)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopAllSessionsLocked()
	for i := range m.rules {
		m.rules[i].Enforced = false
		m.rules[i].LastError = ""
	}
	return nil
}

func detectWinDivertPresence() bool {
	exe, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(exe)
		if fileExists(filepath.Join(dir, "WinDivert.dll")) || fileExists(filepath.Join(dir, "WinDivert64.dll")) {
			return true
		}
	}

	if fileExists("WinDivert.dll") || fileExists("WinDivert64.dll") {
		return true
	}
	return false
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

type pidSession struct {
	pid    int
	handle uintptr
	stop   func()
}

func (m *Manager) startSessionsLocked() {
	wantPIDs := map[int]struct{}{}
	for i := range m.rules {
		m.rules[i].Enforced = false
		m.rules[i].LastError = ""
		wantPIDs[m.rules[i].PID] = struct{}{}
	}

	if len(wantPIDs) == 0 {
		return
	}

	for pid := range wantPIDs {
		handle, stopFn, err := m.diverter.StartPID(pid)
		if err != nil {
			for i := range m.rules {
				if m.rules[i].PID == pid {
					m.rules[i].Enforced = false
					m.rules[i].LastError = err.Error()
				}
			}
			continue
		}

		m.sessions[pid] = &pidSession{
			pid:    pid,
			handle: handle,
			stop:   stopFn,
		}

		for i := range m.rules {
			if m.rules[i].PID == pid {
				m.rules[i].Enforced = true
				m.rules[i].LastError = "windivert capture-only"
			}
		}
	}
}

func (m *Manager) stopAllSessionsLocked() {
	for pid, sess := range m.sessions {
		if sess.stop != nil {
			sess.stop()
		}
		delete(m.sessions, pid)
	}
}

func (m *Manager) applyFirewallIfNeeded() {
	m.mu.Lock()
	if !m.enabled || m.backend != "firewall" {
		m.mu.Unlock()
		return
	}
	rules := make([]Rule, len(m.rules))
	copy(rules, m.rules)
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	next, _ := enforceFirewallRules(ctx, rules)
	m.mu.Lock()
	m.rules = next
	m.mu.Unlock()
}
