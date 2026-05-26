package monitor

import (
	"bufio"
	"context"
	"errors"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type Connection struct {
	Proto  string `json:"proto"`
	Local  string `json:"local"`
	Remote string `json:"remote"`
	State  string `json:"state,omitempty"`
	PID    int    `json:"pid,omitempty"`
}

type Snapshot struct {
	TakenAt     time.Time    `json:"taken_at"`
	Connections []Connection `json:"connections"`
}

type Manager struct {
	logger *log.Logger
}

func NewManager(logger *log.Logger) *Manager {
	return &Manager{logger: logger}
}

func (m *Manager) Snapshot(ctx context.Context) (Snapshot, error) {
	out, err := exec.CommandContext(ctx, "netstat", "-ano").CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return Snapshot{}, errors.New(string(out))
		}
		return Snapshot{}, err
	}

	conns := parseNetstat(string(out))
	return Snapshot{
		TakenAt:     time.Now().UTC(),
		Connections: conns,
	}, nil
}

func parseNetstat(s string) []Connection {
	sc := bufio.NewScanner(strings.NewReader(s))
	var out []Connection
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "Proto") || strings.HasPrefix(line, "Active") {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}

		proto := fields[0]
		if proto != "TCP" && proto != "UDP" {
			continue
		}

		if proto == "UDP" {
			local := fields[1]
			remote := fields[2]
			pid := parseInt(fields[len(fields)-1])
			out = append(out, Connection{Proto: proto, Local: local, Remote: remote, PID: pid})
			continue
		}

		if len(fields) < 5 {
			continue
		}
		local := fields[1]
		remote := fields[2]
		state := fields[3]
		pid := parseInt(fields[4])
		out = append(out, Connection{Proto: proto, Local: local, Remote: remote, State: state, PID: pid})
	}
	return out
}

func parseInt(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}
