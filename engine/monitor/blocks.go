package monitor

import (
	"context"
	"errors"
	"net"
	"sort"
	"strings"
)

type BlocksStatus struct {
	BlockedIPs []string `json:"blocked_ips"`
}

func (m *Manager) BlocksStatus() BlocksStatus {
	m.mu.Lock()
	defer m.mu.Unlock()

	ips := make([]string, 0, len(m.blockedIPs))
	for ip := range m.blockedIPs {
		ips = append(ips, ip)
	}
	sort.Strings(ips)
	return BlocksStatus{BlockedIPs: ips}
}

func (m *Manager) BlockIP(ctx context.Context, ip string) error {
	ip = strings.TrimSpace(ip)
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.To4() == nil {
		return errors.New("invalid ipv4 address")
	}

	if err := applyTrackerBlockRule(ctx, ip); err != nil {
		return err
	}

	m.mu.Lock()
	m.blockedIPs[ip] = struct{}{}
	m.mu.Unlock()
	return nil
}

func (m *Manager) UnblockIP(ctx context.Context, ip string) error {
	ip = strings.TrimSpace(ip)
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.To4() == nil {
		return errors.New("invalid ipv4 address")
	}

	if err := removeTrackerBlockRule(ctx, ip); err != nil {
		return err
	}

	m.mu.Lock()
	delete(m.blockedIPs, ip)
	m.mu.Unlock()
	return nil
}

func (m *Manager) ClearBlocks(ctx context.Context) error {
	if err := clearTrackerBlockRules(ctx); err != nil {
		return err
	}

	m.mu.Lock()
	m.blockedIPs = map[string]struct{}{}
	m.mu.Unlock()
	return nil
}

