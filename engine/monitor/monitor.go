package monitor

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Connection struct {
	Proto string `json:"proto"`
	Local string `json:"local"`

	LocalIP   string `json:"local_ip,omitempty"`
	LocalPort int    `json:"local_port,omitempty"`

	Remote string `json:"remote"`

	RemoteIP    string `json:"remote_ip,omitempty"`
	RemotePort  int    `json:"remote_port,omitempty"`
	RemoteRDNS  string `json:"remote_rdns,omitempty"`
	RemoteClass string `json:"remote_class,omitempty"`

	State       string `json:"state,omitempty"`
	PID         int    `json:"pid,omitempty"`
	ProcessName string `json:"process_name,omitempty"`
	ProcessPath string `json:"process_path,omitempty"`
}

type Snapshot struct {
	TakenAt     time.Time    `json:"taken_at"`
	Connections []Connection `json:"connections"`
}

type Manager struct {
	logger *log.Logger

	mu           sync.Mutex
	procCache    map[int]procEntry
	rdnsCache    map[string]rdnsEntry
	blockedIPs   map[string]struct{}
	blockedSince *time.Time
}

func NewManager(logger *log.Logger) *Manager {
	return &Manager{
		logger:     logger,
		procCache:  map[int]procEntry{},
		rdnsCache:  map[string]rdnsEntry{},
		blockedIPs: map[string]struct{}{},
	}
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
	m.enrich(ctx, conns)
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

type procEntry struct {
	name    string
	path    string
	expires time.Time
}

type rdnsEntry struct {
	rdns    string
	expires time.Time
}

func (m *Manager) enrich(ctx context.Context, conns []Connection) {
	now := time.Now()

	pidSet := map[int]struct{}{}
	ipSet := map[string]struct{}{}
	for i := range conns {
		li, lp, _ := parseEndpoint(conns[i].Local)
		ri, rp, _ := parseEndpoint(conns[i].Remote)
		conns[i].LocalIP = li
		conns[i].LocalPort = lp
		conns[i].RemoteIP = ri
		conns[i].RemotePort = rp
		conns[i].RemoteClass = classifyIP(ri)

		if conns[i].PID > 0 {
			pidSet[conns[i].PID] = struct{}{}
		}
		if ri != "" && conns[i].RemoteClass == "public" {
			ipSet[ri] = struct{}{}
		}
	}

	m.populateProcessCache(ctx, now, pidSet)
	m.populateRDNScache(ctx, now, ipSet, 20)

	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range conns {
		if conns[i].PID > 0 {
			if pe, ok := m.procCache[conns[i].PID]; ok && pe.expires.After(now) {
				conns[i].ProcessName = pe.name
				conns[i].ProcessPath = pe.path
			}
		}
		if conns[i].RemoteIP != "" {
			if re, ok := m.rdnsCache[conns[i].RemoteIP]; ok && re.expires.After(now) {
				conns[i].RemoteRDNS = re.rdns
			}
		}
	}
}

func (m *Manager) populateProcessCache(ctx context.Context, now time.Time, pids map[int]struct{}) {
	var missing []int

	m.mu.Lock()
	for pid := range pids {
		if pe, ok := m.procCache[pid]; ok && pe.expires.After(now) {
			continue
		}
		missing = append(missing, pid)
	}
	m.mu.Unlock()

	if len(missing) == 0 {
		return
	}

	ctx, cancel := context.WithTimeout(ctx, 800*time.Millisecond)
	defer cancel()

	infos, err := queryProcesses(ctx, missing)
	if err != nil {
		return
	}

	expires := now.Add(45 * time.Second)
	m.mu.Lock()
	for pid, pi := range infos {
		m.procCache[pid] = procEntry{name: pi.name, path: pi.path, expires: expires}
	}
	m.mu.Unlock()
}

func (m *Manager) populateRDNScache(ctx context.Context, now time.Time, ips map[string]struct{}, limit int) {
	var missing []string

	m.mu.Lock()
	for ip := range ips {
		if re, ok := m.rdnsCache[ip]; ok && re.expires.After(now) {
			continue
		}
		missing = append(missing, ip)
	}
	m.mu.Unlock()

	if len(missing) == 0 {
		return
	}
	if limit > 0 && len(missing) > limit {
		missing = missing[:limit]
	}

	for _, ip := range missing {
		ctxOne, cancel := context.WithTimeout(ctx, 350*time.Millisecond)
		names, err := net.DefaultResolver.LookupAddr(ctxOne, ip)
		cancel()
		if err != nil || len(names) == 0 {
			continue
		}
		rdns := strings.TrimSuffix(strings.TrimSpace(names[0]), ".")
		if rdns == "" {
			continue
		}
		m.mu.Lock()
		m.rdnsCache[ip] = rdnsEntry{rdns: rdns, expires: now.Add(6 * time.Minute)}
		m.mu.Unlock()
	}
}

type procInfo struct {
	name string
	path string
}

func queryProcesses(ctx context.Context, pids []int) (map[int]procInfo, error) {
	if len(pids) == 0 {
		return map[int]procInfo{}, nil
	}

	var ids []string
	for _, pid := range pids {
		if pid > 0 {
			ids = append(ids, strconv.Itoa(pid))
		}
	}
	if len(ids) == 0 {
		return map[int]procInfo{}, nil
	}

	cmd := []string{
		"-NoProfile",
		"-Command",
		"Get-Process -Id " + strings.Join(ids, ",") + " | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress",
	}
	out, err := exec.CommandContext(ctx, "powershell", cmd...).CombinedOutput()
	if err != nil {
		return nil, errors.New(string(out))
	}

	raw := strings.TrimSpace(string(out))
	if raw == "" {
		return map[int]procInfo{}, nil
	}

	var anyVal any
	if err := json.Unmarshal([]byte(raw), &anyVal); err != nil {
		return map[int]procInfo{}, nil
	}

	items := []map[string]any{}
	switch v := anyVal.(type) {
	case []any:
		for _, it := range v {
			m, ok := it.(map[string]any)
			if ok {
				items = append(items, m)
			}
		}
	case map[string]any:
		items = append(items, v)
	default:
		return map[int]procInfo{}, nil
	}

	outMap := map[int]procInfo{}
	for _, it := range items {
		id, _ := it["Id"].(float64)
		pid := int(id)
		if pid <= 0 {
			continue
		}
		name, _ := it["ProcessName"].(string)
		path, _ := it["Path"].(string)
		outMap[pid] = procInfo{name: name, path: path}
	}
	return outMap, nil
}

func parseEndpoint(s string) (ip string, port int, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" || s == "*:*" {
		return "", 0, false
	}
	if strings.HasPrefix(s, "[") {
		host, portStr, err := net.SplitHostPort(s)
		if err != nil {
			return "", 0, false
		}
		host = strings.Trim(host, "[]")
		p, err := strconv.Atoi(portStr)
		if err != nil {
			p = 0
		}
		return host, p, true
	}
	host, portStr, err := net.SplitHostPort(s)
	if err != nil {
		return "", 0, false
	}
	p, err := strconv.Atoi(portStr)
	if err != nil {
		p = 0
	}
	return host, p, true
}

func classifyIP(ip string) string {
	if ip == "" || ip == "*" {
		return ""
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return ""
	}
	if parsed.IsLoopback() {
		return "loopback"
	}
	if parsed.IsPrivate() {
		return "private"
	}
	if parsed.IsLinkLocalUnicast() || parsed.IsLinkLocalMulticast() {
		return "linklocal"
	}
	if parsed.IsMulticast() {
		return "multicast"
	}
	return "public"
}
