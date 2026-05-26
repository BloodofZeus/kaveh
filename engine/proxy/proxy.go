package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type Manager struct {
	logger *log.Logger

	mu     sync.Mutex
	server *http.Server
	cfg    ProxyConfig
}

type ProxyConfig struct {
	ListenAddr       string   `json:"listen_addr"`
	Upstream         string   `json:"upstream,omitempty"`
	UpstreamChain    []string `json:"upstream_chain,omitempty"`
	ResolveDefault   bool     `json:"resolve_default,omitempty"`
	UserAgent        string   `json:"user_agent,omitempty"`
	StripHeaders     bool     `json:"strip_headers,omitempty"`
	AcceptLanguage   string   `json:"accept_language,omitempty"`
	StripClientHints bool     `json:"strip_client_hints,omitempty"`
}

type ProxyStatus struct {
	Running          bool       `json:"running"`
	ListenAddr       string     `json:"listen_addr,omitempty"`
	Upstream         string     `json:"upstream,omitempty"`
	UpstreamChain    []string   `json:"upstream_chain,omitempty"`
	UserAgent        string     `json:"user_agent,omitempty"`
	StripHeaders     bool       `json:"strip_headers,omitempty"`
	AcceptLanguage   string     `json:"accept_language,omitempty"`
	StripClientHints bool       `json:"strip_client_hints,omitempty"`
	Since            *time.Time `json:"since,omitempty"`
}

func NewManager(logger *log.Logger) *Manager {
	return &Manager{
		logger: logger,
		cfg: ProxyConfig{
			ListenAddr: "127.0.0.1:18080",
		},
	}
}

func (m *Manager) Status() ProxyStatus {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.server == nil {
		return ProxyStatus{Running: false}
	}

	return ProxyStatus{
		Running:          true,
		ListenAddr:       m.cfg.ListenAddr,
		Upstream:         m.cfg.Upstream,
		UpstreamChain:    append([]string(nil), m.cfg.UpstreamChain...),
		UserAgent:        m.cfg.UserAgent,
		StripHeaders:     m.cfg.StripHeaders,
		AcceptLanguage:   m.cfg.AcceptLanguage,
		StripClientHints: m.cfg.StripClientHints,
	}
}

func (m *Manager) Start(ctx context.Context, cfg ProxyConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if cfg.ListenAddr == "" {
		cfg.ListenAddr = "127.0.0.1:18080"
	}

	if m.server != nil {
		return errors.New("proxy already running")
	}

	upstreamChain, err := parseOptionalURLChain(cfg.Upstream, cfg.UpstreamChain)
	if err != nil {
		return err
	}

	handler := &forwardProxy{
		logger:           m.logger,
		upstreamChain:    upstreamChain,
		userAgent:        strings.TrimSpace(cfg.UserAgent),
		stripHeaders:     cfg.StripHeaders,
		acceptLanguage:   strings.TrimSpace(cfg.AcceptLanguage),
		stripClientHints: cfg.StripClientHints,
	}

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", cfg.ListenAddr)
	if err != nil {
		return err
	}

	m.server = srv
	m.cfg = cfg

	go func() {
		m.logger.Printf("proxy listening on %s", cfg.ListenAddr)
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			m.logger.Printf("proxy server error: %v", err)
		}
	}()

	return nil
}

func (m *Manager) Stop(ctx context.Context) error {
	m.mu.Lock()
	srv := m.server
	m.server = nil
	m.mu.Unlock()

	if srv == nil {
		return nil
	}
	return srv.Shutdown(ctx)
}

type forwardProxy struct {
	logger *log.Logger

	upstreamChain    []*url.URL
	userAgent        string
	stripHeaders     bool
	acceptLanguage   string
	stripClientHints bool
}

func (p *forwardProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.handleConnect(w, r)
		return
	}

	p.handleHTTP(w, r)
}

func (p *forwardProxy) handleHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL == nil || r.URL.Scheme == "" || r.URL.Host == "" {
		http.Error(w, "expected absolute-form URL", http.StatusBadRequest)
		return
	}

	outReq := r.Clone(r.Context())
	outReq.RequestURI = ""
	if outReq.Header == nil {
		outReq.Header = make(http.Header)
	}

	if p.stripHeaders {
		stripProxyLeakHeaders(outReq.Header)
	}
	if p.stripClientHints {
		stripClientHintHeaders(outReq.Header)
	}
	if p.userAgent != "" {
		outReq.Header.Set("User-Agent", p.userAgent)
	}
	if p.acceptLanguage != "" {
		outReq.Header.Set("Accept-Language", p.acceptLanguage)
	}

	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialDirectOrChain(ctx, p.upstreamChain, addr)
		},
		ForceAttemptHTTP2:     false,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		ResponseHeaderTimeout: 30 * time.Second,
	}

	resp, err := transport.RoundTrip(outReq)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func stripProxyLeakHeaders(h http.Header) {
	h.Del("Proxy-Connection")
	h.Del("Proxy-Authenticate")
	h.Del("Proxy-Authorization")
	h.Del("Connection")
	h.Del("Keep-Alive")
	h.Del("TE")
	h.Del("Trailer")
	h.Del("Transfer-Encoding")
	h.Del("Upgrade")
	h.Del("Forwarded")
	h.Del("Via")
	h.Del("X-Forwarded-For")
	h.Del("X-Forwarded-Host")
	h.Del("X-Forwarded-Proto")
}

func stripClientHintHeaders(h http.Header) {
	h.Del("Sec-CH-UA")
	h.Del("Sec-CH-UA-Arch")
	h.Del("Sec-CH-UA-Bitness")
	h.Del("Sec-CH-UA-Full-Version")
	h.Del("Sec-CH-UA-Full-Version-List")
	h.Del("Sec-CH-UA-Mobile")
	h.Del("Sec-CH-UA-Model")
	h.Del("Sec-CH-UA-Platform")
	h.Del("Sec-CH-UA-Platform-Version")
	h.Del("Device-Memory")
	h.Del("DPR")
	h.Del("Viewport-Width")
	h.Del("Width")
	h.Del("Downlink")
	h.Del("ECT")
	h.Del("RTT")
	h.Del("Save-Data")
}

func (p *forwardProxy) handleConnect(w http.ResponseWriter, r *http.Request) {
	destAddr := r.Host
	if !strings.Contains(destAddr, ":") {
		destAddr += ":443"
	}

	var (
		serverConn net.Conn
		err        error
	)

	serverConn, err = dialDirectOrChain(r.Context(), p.upstreamChain, destAddr)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		_ = serverConn.Close()
		http.Error(w, "hijacking not supported", http.StatusInternalServerError)
		return
	}
	clientConn, buf, err := hj.Hijack()
	if err != nil {
		_ = serverConn.Close()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	_, _ = clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
	if buf.Reader.Buffered() > 0 {
		_, _ = io.Copy(serverConn, buf)
	}

	go pipeAndClose(serverConn, clientConn)
	go pipeAndClose(clientConn, serverConn)
}

func dialDirectOrChain(ctx context.Context, chain []*url.URL, destAddr string) (net.Conn, error) {
	if len(chain) == 0 {
		dialer := &net.Dialer{Timeout: 15 * time.Second}
		return dialer.DialContext(ctx, "tcp", destAddr)
	}
	return dialThroughChain(ctx, chain, destAddr)
}

func dialThroughChain(ctx context.Context, chain []*url.URL, destAddr string) (net.Conn, error) {
	first := chain[0]
	c, err := dialProxy(ctx, first)
	if err != nil {
		return nil, err
	}

	for i := 0; i < len(chain); i++ {
		current := chain[i]

		var nextAddr string
		var nextScheme string
		var nextSNI string
		if i+1 < len(chain) {
			next := chain[i+1]
			nextAddr = withDefaultPort(next)
			nextScheme = next.Scheme
			nextSNI = next.Hostname()
		} else {
			nextAddr = destAddr
			nextScheme = ""
			nextSNI = ""
		}

		c2, err := connectViaHTTPProxy(ctx, c, current, nextAddr)
		if err != nil {
			_ = c.Close()
			return nil, err
		}
		c = c2

		if nextScheme == "https" {
			tlsConn := tls.Client(c, &tls.Config{ServerName: nextSNI, MinVersion: tls.VersionTLS12})
			if err := tlsConn.HandshakeContext(ctx); err != nil {
				_ = c.Close()
				return nil, err
			}
			c = tlsConn
		}
	}

	return c, nil
}

func dialProxy(ctx context.Context, proxyURL *url.URL) (net.Conn, error) {
	if proxyURL.Scheme != "http" && proxyURL.Scheme != "https" {
		return nil, errors.New("only http(s) upstream proxies are supported")
	}

	hostport := withDefaultPort(proxyURL)
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	c, err := dialer.DialContext(ctx, "tcp", hostport)
	if err != nil {
		return nil, err
	}

	if proxyURL.Scheme == "https" {
		sni := proxyURL.Hostname()
		tlsConn := tls.Client(c, &tls.Config{ServerName: sni, MinVersion: tls.VersionTLS12})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = c.Close()
			return nil, err
		}
		return tlsConn, nil
	}

	return c, nil
}

func connectViaHTTPProxy(ctx context.Context, c net.Conn, proxyURL *url.URL, nextAddr string) (net.Conn, error) {
	req := &http.Request{
		Method: http.MethodConnect,
		URL:    &url.URL{Opaque: nextAddr},
		Host:   nextAddr,
		Header: make(http.Header),
	}

	if proxyURL.User != nil {
		user := proxyURL.User.Username()
		pass, _ := proxyURL.User.Password()
		req.SetBasicAuth(user, pass)
	}

	if err := req.Write(c); err != nil {
		return nil, err
	}

	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		return nil, err
	}
	_ = resp.Body.Close()

	if resp.StatusCode/100 != 2 {
		return nil, errors.New("upstream connect failed: " + resp.Status)
	}

	return &bufferedConn{Conn: c, reader: br}, nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) {
	return c.reader.Read(p)
}

func pipeAndClose(dst io.WriteCloser, src io.ReadCloser) {
	_, _ = io.Copy(dst, src)
	_ = dst.Close()
	_ = src.Close()
}

func parseOptionalURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "" || u.Host == "" {
		return nil, errors.New("upstream must be a full URL like http://host:port")
	}
	return u, nil
}

func parseOptionalURLChain(upstream string, upstreamChain []string) ([]*url.URL, error) {
	var raw []string
	for _, v := range upstreamChain {
		if strings.TrimSpace(v) != "" {
			raw = append(raw, v)
		}
	}
	if len(raw) == 0 && strings.TrimSpace(upstream) != "" {
		raw = []string{upstream}
	}
	if len(raw) == 0 {
		return nil, nil
	}

	out := make([]*url.URL, 0, len(raw))
	for _, s := range raw {
		u, err := parseOptionalURL(s)
		if err != nil {
			return nil, err
		}
		if u == nil {
			continue
		}
		out = append(out, u)
	}
	return out, nil
}

func withDefaultPort(u *url.URL) string {
	hostport := u.Host
	if strings.Contains(hostport, ":") {
		return hostport
	}
	if u.Scheme == "https" {
		return hostport + ":443"
	}
	return hostport + ":80"
}

func copyHeaders(dst, src http.Header) {
	for k, values := range src {
		for _, v := range values {
			dst.Add(k, v)
		}
	}
}

type apiError struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(v)
}
