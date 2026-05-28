package killswitch

import (
	"context"
	"errors"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"
)

type Status struct {
	Enabled bool       `json:"enabled"`
	Since   *time.Time `json:"since,omitempty"`
}

type Manager struct {
	logger *log.Logger

	mu    sync.Mutex
	since *time.Time
}

func NewManager(logger *log.Logger) *Manager {
	return &Manager{logger: logger}
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()

	return Status{
		Enabled: m.since != nil,
		Since:   m.since,
	}
}

func (m *Manager) Enable(ctx context.Context) error {
	m.mu.Lock()
	if m.since != nil {
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()

	if err := runNetsh(ctx, []string{"advfirewall", "firewall", "delete", "rule", "group=Kaveh"}); err != nil {
		return err
	}
	if err := runNetsh(ctx, []string{"advfirewall", "firewall", "add", "rule", "name=Kaveh KillSwitch Outbound", "dir=out", "action=block", "enable=yes", "profile=any", "group=Kaveh"}); err != nil {
		return err
	}

	now := time.Now().UTC()
	m.mu.Lock()
	m.since = &now
	m.mu.Unlock()
	return nil
}

func (m *Manager) Disable(ctx context.Context) error {
	if err := runNetsh(ctx, []string{"advfirewall", "firewall", "delete", "rule", "group=Kaveh"}); err != nil {
		return err
	}

	m.mu.Lock()
	m.since = nil
	m.mu.Unlock()
	return nil
}

func runNetsh(ctx context.Context, args []string) error {
	if os.Getenv("KAVEH_TEST_MODE") == "1" {
		return nil
	}
	cmd := exec.CommandContext(ctx, "netsh", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return errors.New(string(out))
		}
		return err
	}
	return nil
}
