package killswitch

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestAPIEnable_RequiresConfirm(t *testing.T) {
	t.Setenv("KAVEH_TEST_MODE", "1")

	m := NewManager(log.New(os.Stdout, "", 0))
	s := NewAPIServer(m)
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/killswitch/enable", bytes.NewBufferString(`{}`))
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", rec.Code, rec.Body.String())
	}
	if m.Status().Enabled {
		t.Fatalf("expected killswitch to remain disabled")
	}

	rec2 := httptest.NewRecorder()
	body, _ := json.Marshal(map[string]any{"confirm": true})
	req2 := httptest.NewRequest(http.MethodPost, "/killswitch/enable", bytes.NewReader(body))
	mux.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec2.Code, rec2.Body.String())
	}
	if !m.Status().Enabled {
		t.Fatalf("expected killswitch enabled")
	}
}

func TestAPIDisable_Idempotent(t *testing.T) {
	t.Setenv("KAVEH_TEST_MODE", "1")

	m := NewManager(log.New(os.Stdout, "", 0))
	s := NewAPIServer(m)
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/killswitch/disable", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/killswitch/disable", nil)
	mux.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec2.Code, rec2.Body.String())
	}
	if m.Status().Enabled {
		t.Fatalf("expected killswitch disabled")
	}
}
