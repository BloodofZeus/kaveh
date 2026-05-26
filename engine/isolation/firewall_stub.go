//go:build !windows

package isolation

import (
	"context"
	"errors"
)

func enforceFirewallRules(ctx context.Context, rules []Rule) ([]Rule, error) {
	_ = ctx
	next := make([]Rule, len(rules))
	copy(next, rules)
	for i := range next {
		next[i].Enforced = false
		next[i].LastError = "firewall backend only supported on windows"
	}
	return next, errors.New("firewall backend only supported on windows")
}

func disableFirewallRules(ctx context.Context) error {
	_ = ctx
	return errors.New("firewall backend only supported on windows")
}
