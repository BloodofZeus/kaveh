package dns

import (
	"bufio"
	"context"
	"errors"
	"log"
	"net"
	"os/exec"
	"strings"
	"time"
)

type Status struct {
	Servers   []string  `json:"servers"`
	CheckedAt time.Time `json:"checked_at"`
}

type Manager struct {
	logger *log.Logger
}

func NewManager(logger *log.Logger) *Manager {
	return &Manager{logger: logger}
}

func (m *Manager) Status(ctx context.Context) (Status, error) {
	out, err := exec.CommandContext(ctx, "netsh", "interface", "ip", "show", "dnsservers").CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return Status{}, errors.New(string(out))
		}
		return Status{}, err
	}

	servers := extractIPv4s(string(out))
	return Status{
		Servers:   servers,
		CheckedAt: time.Now().UTC(),
	}, nil
}

func (m *Manager) Flush(ctx context.Context) error {
	out, err := exec.CommandContext(ctx, "ipconfig", "/flushdns").CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return errors.New(string(out))
		}
		return err
	}
	return nil
}

func extractIPv4s(s string) []string {
	sc := bufio.NewScanner(strings.NewReader(s))
	seen := map[string]struct{}{}
	var out []string
	for sc.Scan() {
		line := sc.Text()
		fields := strings.Fields(line)
		for _, f := range fields {
			f = strings.Trim(f, " ,;")
			ip := net.ParseIP(f)
			if ip == nil {
				continue
			}
			ip4 := ip.To4()
			if ip4 == nil {
				continue
			}
			key := ip4.String()
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, key)
		}
	}
	return out
}
