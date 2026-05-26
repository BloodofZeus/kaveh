package dns

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Status struct {
	Servers   []string  `json:"servers"`
	CheckedAt time.Time `json:"checked_at"`
}

type Interface struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

type EnforceStatus struct {
	Enabled   bool       `json:"enabled"`
	Servers   []string   `json:"servers"`
	Supported bool       `json:"supported"`
	Since     *time.Time `json:"since,omitempty"`
}

type Manager struct {
	logger *log.Logger

	mu      sync.Mutex
	enforce EnforceStatus
}

func NewManager(logger *log.Logger) *Manager {
	return &Manager{
		logger: logger,
		enforce: EnforceStatus{
			Enabled:   false,
			Supported: true,
			Servers:   nil,
		},
	}
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

func (m *Manager) Interfaces(ctx context.Context) ([]Interface, error) {
	out, err := exec.CommandContext(ctx, "powershell", "-NoProfile", "-Command", "Get-NetAdapter | Select-Object -First 40 Name,Status | ConvertTo-Json -Compress").CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return nil, errors.New(string(out))
		}
		return nil, err
	}
	raw := strings.TrimSpace(string(out))
	if raw == "" {
		return nil, nil
	}

	var anyVal any
	if err := json.Unmarshal([]byte(raw), &anyVal); err != nil {
		return nil, nil
	}

	var items []map[string]any
	switch v := anyVal.(type) {
	case []any:
		for _, it := range v {
			mm, ok := it.(map[string]any)
			if ok {
				items = append(items, mm)
			}
		}
	case map[string]any:
		items = append(items, v)
	default:
		return nil, nil
	}

	var outItems []Interface
	for _, it := range items {
		name, _ := it["Name"].(string)
		status, _ := it["Status"].(string)
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		outItems = append(outItems, Interface{Name: name, Status: strings.TrimSpace(status)})
	}
	return outItems, nil
}

func (m *Manager) SetServers(ctx context.Context, interfaceName string, servers []string) error {
	interfaceName = strings.TrimSpace(interfaceName)
	if !validAdapterName(interfaceName) {
		return errors.New("invalid interface name")
	}

	var cleaned []string
	for _, s := range servers {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		ip := net.ParseIP(s)
		if ip == nil || ip.To4() == nil {
			return errors.New("invalid dns server ip")
		}
		cleaned = append(cleaned, ip.String())
	}
	if len(cleaned) == 0 {
		return errors.New("dns server list is empty")
	}

	var quoted []string
	for _, ip := range cleaned {
		quoted = append(quoted, `"`+ip+`"`)
	}

	cmd := exec.CommandContext(
		ctx,
		"powershell",
		"-NoProfile",
		"-Command",
		`Set-DnsClientServerAddress -InterfaceAlias "`+interfaceName+`" -ServerAddresses @(`+strings.Join(quoted, ",")+`)`,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return errors.New(string(out))
		}
		return err
	}
	return nil
}

func (m *Manager) Enforce(ctx context.Context, servers []string) (EnforceStatus, error) {
	var cleaned []string
	for _, s := range servers {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		ip := net.ParseIP(s)
		if ip == nil || ip.To4() == nil {
			return EnforceStatus{}, errors.New("invalid dns server ip")
		}
		cleaned = append(cleaned, ip.String())
	}
	if len(cleaned) == 0 {
		return EnforceStatus{}, errors.New("dns server list is empty")
	}

	if err := runNetsh(ctx, []string{"advfirewall", "firewall", "delete", "rule", "group=KavehDNS"}); err != nil {
		return EnforceStatus{}, err
	}

	for _, ip := range cleaned {
		if err := runNetsh(ctx, []string{
			"advfirewall", "firewall", "add", "rule",
			"name=Kaveh DNS Allow UDP " + ip,
			"dir=out",
			"action=allow",
			"enable=yes",
			"profile=any",
			"protocol=UDP",
			"remoteport=53",
			"remoteip=" + ip,
			"group=KavehDNS",
		}); err != nil {
			return EnforceStatus{}, err
		}
		if err := runNetsh(ctx, []string{
			"advfirewall", "firewall", "add", "rule",
			"name=Kaveh DNS Allow TCP " + ip,
			"dir=out",
			"action=allow",
			"enable=yes",
			"profile=any",
			"protocol=TCP",
			"remoteport=53",
			"remoteip=" + ip,
			"group=KavehDNS",
		}); err != nil {
			return EnforceStatus{}, err
		}
	}

	if err := runNetsh(ctx, []string{
		"advfirewall", "firewall", "add", "rule",
		"name=Kaveh DNS Block UDP",
		"dir=out",
		"action=block",
		"enable=yes",
		"profile=any",
		"protocol=UDP",
		"remoteport=53",
		"group=KavehDNS",
	}); err != nil {
		return EnforceStatus{}, err
	}
	if err := runNetsh(ctx, []string{
		"advfirewall", "firewall", "add", "rule",
		"name=Kaveh DNS Block TCP",
		"dir=out",
		"action=block",
		"enable=yes",
		"profile=any",
		"protocol=TCP",
		"remoteport=53",
		"group=KavehDNS",
	}); err != nil {
		return EnforceStatus{}, err
	}

	now := time.Now().UTC()
	m.mu.Lock()
	m.enforce = EnforceStatus{Enabled: true, Supported: true, Servers: cleaned, Since: &now}
	es := m.enforce
	m.mu.Unlock()
	return es, nil
}

func (m *Manager) Unenforce(ctx context.Context) (EnforceStatus, error) {
	if err := runNetsh(ctx, []string{"advfirewall", "firewall", "delete", "rule", "group=KavehDNS"}); err != nil {
		return EnforceStatus{}, err
	}

	m.mu.Lock()
	m.enforce.Enabled = false
	m.enforce.Since = nil
	m.enforce.Servers = nil
	es := m.enforce
	m.mu.Unlock()
	return es, nil
}

func (m *Manager) EnforceStatus() EnforceStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.enforce
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

var adapterNameRe = regexp.MustCompile(`^[a-zA-Z0-9 _\-\.\(\)\[\]]{1,64}$`)

func validAdapterName(s string) bool {
	return adapterNameRe.MatchString(s)
}

func runNetsh(ctx context.Context, args []string) error {
	out, err := exec.CommandContext(ctx, "netsh", args...).CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return errors.New(string(out))
		}
		return err
	}
	return nil
}
