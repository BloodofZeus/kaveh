//go:build !windows

package fingerprint

import (
	"context"
	"errors"
)

func jsLeakSupported() bool {
	return false
}

func jsLeakDisableRules(ctx context.Context) error {
	_ = ctx
	return errors.New("js leak protection not supported on this platform")
}

func jsLeakApplyRules(ctx context.Context, cfg JSLeakConfig) error {
	_ = ctx
	_ = cfg
	return errors.New("js leak protection not supported on this platform")
}

