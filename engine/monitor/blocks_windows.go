package monitor

import (
	"context"
	"errors"
	"os/exec"
)

func applyTrackerBlockRule(ctx context.Context, ip string) error {
	_ = runNetsh(ctx, []string{"advfirewall", "firewall", "delete", "rule", "name=Kaveh Tracker Block " + ip, "group=KavehTracker"})
	return runNetsh(ctx, []string{
		"advfirewall", "firewall", "add", "rule",
		"name=Kaveh Tracker Block " + ip,
		"dir=out",
		"action=block",
		"enable=yes",
		"profile=any",
		"remoteip=" + ip,
		"group=KavehTracker",
	})
}

func removeTrackerBlockRule(ctx context.Context, ip string) error {
	return runNetsh(ctx, []string{"advfirewall", "firewall", "delete", "rule", "name=Kaveh Tracker Block " + ip, "group=KavehTracker"})
}

func clearTrackerBlockRules(ctx context.Context) error {
	return runNetsh(ctx, []string{"advfirewall", "firewall", "delete", "rule", "group=KavehTracker"})
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

