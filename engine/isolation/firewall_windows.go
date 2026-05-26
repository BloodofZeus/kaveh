//go:build windows

package isolation

import (
	"context"
	"errors"
	"net"
	"os/exec"
	"strconv"
	"strings"
)

const firewallGroup = "KavehIsolation"

func enforceFirewallRules(ctx context.Context, rules []Rule) ([]Rule, error) {
	next := make([]Rule, len(rules))
	copy(next, rules)

	if err := disableFirewallRules(ctx); err != nil {
		return markAllError(next, err.Error()), err
	}

	var firstErr error
	for i := range next {
		path, err := processPath(ctx, next[i].PID)
		if err != nil {
			next[i].Enforced = false
			next[i].LastError = err.Error()
			if firstErr == nil {
				firstErr = err
			}
			continue
		}

		proxyHost, proxyPort, err := splitHostPort(next[i].ProxyAddr)
		if err != nil {
			next[i].Enforced = false
			next[i].LastError = err.Error()
			if firstErr == nil {
				firstErr = err
			}
			continue
		}

		blockName := "Kaveh Isolation Block PID " + strconv.Itoa(next[i].PID)
		allowName := "Kaveh Isolation Allow Proxy PID " + strconv.Itoa(next[i].PID)
		if err := runNetsh(ctx, []string{
			"advfirewall", "firewall", "add", "rule",
			"name=" + blockName,
			"dir=out",
			"action=block",
			"enable=yes",
			"profile=any",
			"group=" + firewallGroup,
			"program=" + path,
		}); err != nil {
			next[i].Enforced = false
			next[i].LastError = err.Error()
			if firstErr == nil {
				firstErr = err
			}
			continue
		}

		ips := allowedProxyIPs(proxyHost)
		allowsOK := true
		for _, ip := range ips {
			name := allowName + " " + ip
			if err := runNetsh(ctx, []string{
				"advfirewall", "firewall", "add", "rule",
				"name=" + name,
				"dir=out",
				"action=allow",
				"enable=yes",
				"profile=any",
				"group=" + firewallGroup,
				"program=" + path,
				"protocol=TCP",
				"remoteip=" + ip,
				"remoteport=" + proxyPort,
			}); err != nil {
				allowsOK = false
				next[i].LastError = err.Error()
				if firstErr == nil {
					firstErr = err
				}
			}
		}

		next[i].Enforced = allowsOK
		if next[i].Enforced {
			next[i].LastError = ""
		}
	}

	if firstErr != nil {
		return next, firstErr
	}
	return next, nil
}

func disableFirewallRules(ctx context.Context) error {
	return runNetsh(ctx, []string{"advfirewall", "firewall", "delete", "rule", "group=" + firewallGroup})
}

func processPath(ctx context.Context, pid int) (string, error) {
	if pid <= 0 {
		return "", errors.New("pid must be > 0")
	}

	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-Command",
		"(Get-Process -Id "+strconv.Itoa(pid)+" -ErrorAction Stop).Path",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if len(out) > 0 {
			return "", errors.New(strings.TrimSpace(string(out)))
		}
		return "", err
	}
	path := strings.TrimSpace(string(out))
	if path == "" {
		return "", errors.New("process path not available")
	}
	return path, nil
}

func splitHostPort(v string) (string, string, error) {
	host, port, err := net.SplitHostPort(strings.TrimSpace(v))
	if err != nil {
		return "", "", errors.New("invalid proxy_addr, expected host:port")
	}
	if port == "" {
		return "", "", errors.New("invalid proxy_addr, missing port")
	}
	return host, port, nil
}

func allowedProxyIPs(host string) []string {
	h := strings.TrimSpace(strings.ToLower(host))
	if h == "" || h == "localhost" {
		return []string{"127.0.0.1", "::1"}
	}
	ip := net.ParseIP(h)
	if ip == nil {
		return []string{"127.0.0.1", "::1"}
	}
	if ip.To4() != nil {
		return []string{ip.String()}
	}
	return []string{ip.String()}
}

func markAllError(rules []Rule, msg string) []Rule {
	for i := range rules {
		rules[i].Enforced = false
		rules[i].LastError = msg
	}
	return rules
}

func runNetsh(ctx context.Context, args []string) error {
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
