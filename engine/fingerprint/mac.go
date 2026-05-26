package fingerprint

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

type Adapter struct {
	Name                 string `json:"name"`
	InterfaceDescription string `json:"interface_description"`
	MacAddress           string `json:"mac_address"`
	Status               string `json:"status"`
	IfIndex              int    `json:"if_index"`
}

type MacManager struct{}

func NewMacManager() *MacManager {
	return &MacManager{}
}

func (m *MacManager) ListAdapters(ctx context.Context) ([]Adapter, error) {
	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-Command",
		"Get-NetAdapter | Select-Object Name,InterfaceDescription,MacAddress,Status,ifIndex | ConvertTo-Json -Compress",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return nil, errors.New(strings.TrimSpace(string(out)))
		}
		return nil, err
	}

	raw := strings.TrimSpace(string(out))
	if raw == "" {
		return nil, nil
	}

	var anyVal any
	if err := json.Unmarshal([]byte(raw), &anyVal); err != nil {
		return nil, err
	}

	items := []any{}
	switch v := anyVal.(type) {
	case []any:
		items = v
	case map[string]any:
		items = []any{v}
	default:
		return nil, nil
	}

	adapters := make([]Adapter, 0, len(items))
	for _, it := range items {
		obj, ok := it.(map[string]any)
		if !ok {
			continue
		}
		a := Adapter{
			Name:                 asString(obj["Name"]),
			InterfaceDescription: asString(obj["InterfaceDescription"]),
			MacAddress:           asString(obj["MacAddress"]),
			Status:               asString(obj["Status"]),
			IfIndex:              asInt(obj["ifIndex"]),
		}
		if a.Name == "" {
			continue
		}
		adapters = append(adapters, a)
	}
	return adapters, nil
}

func (m *MacManager) Spoof(ctx context.Context, adapterName string, mode string, customMac string) (string, error) {
	if !isSafeAdapterName(adapterName) {
		return "", errors.New("invalid adapter_name")
	}

	var mac string
	switch mode {
	case "random":
		v, err := randomMAC()
		if err != nil {
			return "", err
		}
		mac = v
	case "custom":
		v, err := normalizeMAC(customMac)
		if err != nil {
			return "", err
		}
		mac = v
	default:
		return "", errors.New("invalid mode")
	}

	return mac, runPowerShell(ctx, strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"Set-NetAdapterAdvancedProperty -Name '" + adapterName + "' -RegistryKeyword NetworkAddress -RegistryValue '" + mac + "'",
		"Disable-NetAdapter -Name '" + adapterName + "' -Confirm:$false",
		"Start-Sleep -Milliseconds 600",
		"Enable-NetAdapter -Name '" + adapterName + "' -Confirm:$false",
	}, "; "))
}

func (m *MacManager) Reset(ctx context.Context, adapterName string) error {
	if !isSafeAdapterName(adapterName) {
		return errors.New("invalid adapter_name")
	}

	return runPowerShell(ctx, strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"Remove-NetAdapterAdvancedProperty -Name '" + adapterName + "' -RegistryKeyword NetworkAddress -ErrorAction SilentlyContinue",
		"Disable-NetAdapter -Name '" + adapterName + "' -Confirm:$false",
		"Start-Sleep -Milliseconds 600",
		"Enable-NetAdapter -Name '" + adapterName + "' -Confirm:$false",
	}, "; "))
}

func runPowerShell(ctx context.Context, cmd string) error {
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	ps := exec.CommandContext(cctx, "powershell", "-NoProfile", "-Command", cmd)
	out, err := ps.CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return errors.New(strings.TrimSpace(string(out)))
		}
		return err
	}
	return nil
}

func asString(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func asInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	default:
		return 0
	}
}

var adapterNameRe = regexp.MustCompile(`^[A-Za-z0-9 _.\-]+$`)

func isSafeAdapterName(v string) bool {
	return adapterNameRe.MatchString(v)
}

func randomMAC() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[0] = (b[0] | 0x02) & 0xFE
	return strings.ToUpper(hex.EncodeToString(b)), nil
}

func normalizeMAC(v string) (string, error) {
	s := strings.ToUpper(strings.TrimSpace(v))
	s = strings.NewReplacer(":", "", "-", "", ".", "", " ", "").Replace(s)
	if len(s) != 12 {
		return "", errors.New("mac must be 12 hex chars")
	}
	if _, err := hex.DecodeString(s); err != nil {
		return "", errors.New("mac must be hex")
	}
	first, _ := hex.DecodeString(s[:2])
	if len(first) != 1 {
		return "", errors.New("invalid mac")
	}
	if first[0]&0x01 != 0 {
		return "", errors.New("mac must be unicast")
	}
	if first[0]&0x02 == 0 {
		return "", errors.New("mac must be locally administered")
	}
	return s, nil
}
