//go:build !windows

package monitor

import (
	"context"
	"errors"
)

func applyTrackerBlockRule(ctx context.Context, ip string) error {
	_ = ctx
	_ = ip
	return errors.New("tracker blocking not supported on this platform")
}

func removeTrackerBlockRule(ctx context.Context, ip string) error {
	_ = ctx
	_ = ip
	return errors.New("tracker blocking not supported on this platform")
}

func clearTrackerBlockRules(ctx context.Context) error {
	_ = ctx
	return errors.New("tracker blocking not supported on this platform")
}
