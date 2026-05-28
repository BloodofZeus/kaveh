package killswitch

import (
	"context"
	"log"
	"os"
	"testing"
	"time"
)

func TestManagerEnableDisable_ToggleStatus(t *testing.T) {
	t.Setenv("KAVEH_TEST_MODE", "1")

	m := NewManager(log.New(os.Stdout, "", 0))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if m.Status().Enabled {
		t.Fatalf("expected disabled at start")
	}

	if err := m.Enable(ctx); err != nil {
		t.Fatalf("enable failed: %v", err)
	}
	if !m.Status().Enabled {
		t.Fatalf("expected enabled after enable")
	}

	if err := m.Disable(ctx); err != nil {
		t.Fatalf("disable failed: %v", err)
	}
	if m.Status().Enabled {
		t.Fatalf("expected disabled after disable")
	}
}

