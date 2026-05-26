package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"kaveh/engine/dns"
	"kaveh/engine/fingerprint"
	"kaveh/engine/isolation"
	"kaveh/engine/killswitch"
	"kaveh/engine/monitor"
	"kaveh/engine/proxy"
)

func main() {
	logger := log.New(os.Stdout, "kaveh-engine ", log.LstdFlags|log.LUTC)

	pm := proxy.NewManager(logger)
	ks := killswitch.NewManager(logger)
	dm := dns.NewManager(logger)
	mm := monitor.NewManager(logger)
	im := isolation.NewManager()
	fm := fingerprint.NewMacManager()
	jm := fingerprint.NewJSLeakManager()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	proxy.NewAPIServer(pm, logger).RegisterRoutes(mux)
	killswitch.NewAPIServer(ks).RegisterRoutes(mux)
	dns.NewAPIServer(dm).RegisterRoutes(mux)
	monitor.NewAPIServer(mm).RegisterRoutes(mux)
	isolation.NewAPIServer(im).RegisterRoutes(mux)
	fingerprint.NewMacAPIServer(fm).RegisterRoutes(mux)
	fingerprint.NewJSLeakAPIServer(jm).RegisterRoutes(mux)

	apiServer := &http.Server{
		Addr:              "127.0.0.1:51337",
		Handler:           withJSONErrors(withCORS(mux)),
		ReadHeaderTimeout: 5 * time.Second,
		BaseContext: func(net.Listener) context.Context {
			return context.Background()
		},
	}

	go func() {
		logger.Printf("api listening on %s", apiServer.Addr)
		if err := apiServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Printf("api server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	_ = pm.Stop(ctx)
	_ = ks.Disable(ctx)
	_ = apiServer.Shutdown(ctx)
}

type apiError struct {
	Error string `json:"error"`
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (strings.HasPrefix(origin, "http://localhost:") || strings.HasPrefix(origin, "http://127.0.0.1:")) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func withJSONErrors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				writeJSON(w, http.StatusInternalServerError, apiError{Error: "internal error"})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(v)
}
