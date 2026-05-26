package fingerprint

import (
	"context"
	"errors"
	"os/exec"
)

func jsLeakSupported() bool {
	return true
}

func jsLeakDisableRules(ctx context.Context) error {
	return runNetsh(ctx, []string{"advfirewall", "firewall", "delete", "rule", "group=KavehJSLeak"})
}

func jsLeakApplyRules(ctx context.Context, cfg JSLeakConfig) error {
	if err := jsLeakDisableRules(ctx); err != nil {
		return err
	}

	if cfg.BlockWebRTC {
		if err := runNetsh(ctx, []string{
			"advfirewall", "firewall", "add", "rule",
			"name=Kaveh JS Leak STUN",
			"dir=out",
			"action=block",
			"enable=yes",
			"profile=any",
			"protocol=UDP",
			"remoteport=3478,19302",
			"group=KavehJSLeak",
		}); err != nil {
			return err
		}
	}

	if cfg.BlockMDNS {
		if err := runNetsh(ctx, []string{
			"advfirewall", "firewall", "add", "rule",
			"name=Kaveh JS Leak mDNS",
			"dir=out",
			"action=block",
			"enable=yes",
			"profile=any",
			"protocol=UDP",
			"remoteport=5353",
			"group=KavehJSLeak",
		}); err != nil {
			return err
		}
	}

	if cfg.BlockQUIC {
		if err := runNetsh(ctx, []string{
			"advfirewall", "firewall", "add", "rule",
			"name=Kaveh JS Leak QUIC",
			"dir=out",
			"action=block",
			"enable=yes",
			"profile=any",
			"protocol=UDP",
			"remoteport=443",
			"group=KavehJSLeak",
		}); err != nil {
			return err
		}
	}

	return nil
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
