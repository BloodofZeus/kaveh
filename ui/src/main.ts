type HealthState = {
  pythonOk: boolean;
  engineOk: boolean;
  proxyRunning: boolean;
  killswitchEnabled: boolean;
  dnsServers: string[];
  monitorTakenAt: string;
  connections: Array<{
    proto: string;
    local: string;
    local_ip?: string;
    local_port?: number;
    remote: string;
    remote_ip?: string;
    remote_port?: number;
    remote_rdns?: string;
    remote_class?: string;
    state?: string;
    pid?: number;
    process_name?: string;
    process_path?: string;
  }>;
  maskedIp: string;
  config: AppConfig | null;
  rotationStatus: RotationStatus | null;
  isolationStatus: IsolationStatus | null;
  processes: Array<{ pid: number; name: string }>;
  macAdapters: MacAdapter[];
  jsLeakStatus: JSLeakStatus | null;
  trackerBlocks: string[];
  logs: LogEntry[];
  dnsInterfaces: Array<{ name: string; status: string }>;
  dnsEnforce: { enabled: boolean; supported: boolean; servers: string[]; since?: string | null } | null;
  failoverStatus: FailoverStatus | null;
};

const PYTHON_BASE_URL = "http://localhost:51338";
let killswitchArmed = false;
let activeView: ViewKey = "dashboard";
let configDraft: AppConfig | null = null;
let configSaving = false;
let configError = "";
let actionMsg = "";
let actionError = false;
let actionAt = 0;
let macSpoofArmed = false;
let macResetArmed = false;
let macSelectedAdapter = "";
let macCustom = "";
let jsLeakEnableArmed = false;
let jsLeakDisableArmed = false;
let trafficPaused = false;
let trafficFilter = "";
let trafficHistory: Array<HealthState["connections"][number] & { seen_at: string }> = [];
let trackerFilter = "";
let trackerArmedIp = "";
let trackerArmedAction: "block" | "unblock" | "" = "";
let trackerClearArmed = false;
let logsFilter = "";
let dnsApplyArmed = false;
let dnsEnforceArmed = false;
let dnsUnenforceArmed = false;
let onboardingStep: 1 | 2 | 3 = 1;
let lastState: HealthState | null = null;

function setAction(msg: string, isError: boolean) {
  actionMsg = msg;
  actionError = isError;
  actionAt = Date.now();
  if (lastState) render(lastState);
}

async function apiJson<T>(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: T | null; error: string }> {
  try {
    const res = await fetch(`${PYTHON_BASE_URL}${path}`, init);
    const status = res.status;
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, status, data: null, error: raw || `HTTP ${status}` };
    }
    if (!raw.trim()) return { ok: true, status, data: null, error: "" };
    try {
      return { ok: true, status, data: JSON.parse(raw) as T, error: "" };
    } catch {
      return { ok: true, status, data: null, error: "" };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, data: null, error: msg };
  }
}

async function apiPost(path: string, body?: unknown): Promise<{ ok: boolean; status: number; error: string }> {
  const init: RequestInit = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const r = await apiJson<Record<string, unknown>>(path, init);
  return { ok: r.ok, status: r.status, error: r.error };
}

function bootDiagnostics() {
  window.addEventListener("error", (e) => {
    const msg = (e.error instanceof Error ? e.error.message : e.message) || "Unknown error";
    setAction(`UI error: ${msg}`, true);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    setAction(`Unhandled rejection: ${msg}`, true);
  });
}

async function refreshNow(full: boolean) {
  try {
    lastState = await poll();
    if (lastState) {
      if (full) render(lastState);
      else patch(lastState);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setAction(`Refresh failed: ${msg}`, true);
  }
}

type LogEntry = {
  ts: string;
  level: "ok" | "warn" | "crit";
  type: string;
  message: string;
  data?: Record<string, unknown>;
};

type FailoverStatus = {
  running: boolean;
  enabled: boolean;
  interval_sec: number;
  probe_host: string;
  backups: string[];
  index: number;
  consecutive_failures: number;
  last_ok_at: number | null;
  last_failover_at: number | null;
  last_error: string;
};

type ViewKey = "dashboard" | "proxy" | "dns" | "fingerprint" | "tracker" | "logs" | "onboarding";

type AppConfig = {
  engine_base_url: string;
  api_listen_host: string;
  api_listen_port: number;
  proxy_listen_addr: string;
  upstream_proxy_url: string;
  upstream_proxy_chain: string[];
  proxy_rotation_enabled: boolean;
  proxy_rotation_interval_sec: number;
  proxy_rotation_pool: string[];
  proxy_rotation_index: number;
  fingerprint_user_agent: string;
  fingerprint_strip_headers: boolean;
  fingerprint_accept_language: string;
  fingerprint_strip_client_hints: boolean;
  jsleak_block_webrtc: boolean;
  jsleak_block_mdns: boolean;
  jsleak_block_quic: boolean;
  dns_interface_name: string;
  dns_servers: string[];
  dns_enforce: boolean;
  ui_theme: "dark" | "contrast" | "black";
  ui_profile: "light" | "moderate" | "high" | "custom";
  failover_enabled: boolean;
  failover_check_interval_sec: number;
  failover_probe_host: string;
  failover_backups: string[];
  failover_index: number;
};

type RotationStatus = {
  running: boolean;
  enabled: boolean;
  interval_sec: number;
  pool_size: number;
  index: number;
  current_upstream: string;
  next_upstream: string;
  last_rotated_at: number | null;
  last_error: string;
};

type IsolationRule = {
  pid: number;
  circuit_id: string;
  proxy_addr: string;
  enforced: boolean;
  last_error?: string;
};

type IsolationStatus = {
  enabled: boolean;
  supported: boolean;
  backend: string;
  rules: IsolationRule[];
};

type MacAdapter = {
  name: string;
  interface_description: string;
  mac_address: string;
  status: string;
  if_index: number;
};

type JSLeakStatus = {
  enabled: boolean;
  supported: boolean;
  config?: { block_webrtc?: boolean; block_mdns?: boolean; block_quic?: boolean };
  since?: string | null;
};

function defaultConfig(): AppConfig {
  return {
    engine_base_url: "http://127.0.0.1:51337",
    api_listen_host: "127.0.0.1",
    api_listen_port: 51338,
    proxy_listen_addr: "127.0.0.1:18080",
    upstream_proxy_url: "",
    upstream_proxy_chain: [],
    proxy_rotation_enabled: false,
    proxy_rotation_interval_sec: 900,
    proxy_rotation_pool: [],
    proxy_rotation_index: 0,
    fingerprint_user_agent: "",
    fingerprint_strip_headers: true,
    fingerprint_accept_language: "",
    fingerprint_strip_client_hints: true,
    jsleak_block_webrtc: true,
    jsleak_block_mdns: true,
    jsleak_block_quic: false,
    dns_interface_name: "",
    dns_servers: [],
    dns_enforce: false,
    ui_theme: "dark",
    ui_profile: "custom",
    failover_enabled: false,
    failover_check_interval_sec: 15,
    failover_probe_host: "example.com:443",
    failover_backups: [],
    failover_index: 0,
  };
}

function lucideIcon(name: string): string {
  const common =
    'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"';
  switch (name) {
    case "layout-dashboard":
      return `<svg ${common}><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="10" width="7" height="11"/><rect x="3" y="14" width="7" height="7"/></svg>`;
    case "shield":
      return `<svg ${common}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;
    case "globe":
      return `<svg ${common}><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 0 20"/><path d="M12 2a15.3 15.3 0 0 0 0 20"/></svg>`;
    case "fingerprint":
      return `<svg ${common}><path d="M12 12c2 0 4 1.5 4 4 0 2-1 4-1 6"/><path d="M8 12c0 4 2 6 2 10"/><path d="M12 2a8 8 0 0 0-8 8"/><path d="M20 10a8 8 0 0 0-16 0"/><path d="M12 14c0 3 1 4 1 8"/></svg>`;
    case "radar":
      return `<svg ${common}><circle cx="12" cy="12" r="10"/><path d="M12 2v10l6 6"/><path d="M2 12h10"/></svg>`;
    case "scroll-text":
      return `<svg ${common}><path d="M8 2h8a2 2 0 0 1 2 2v16H8a2 2 0 0 0-2 2V4a2 2 0 0 1 2-2z"/><path d="M6 18h6"/><path d="M6 14h10"/><path d="M6 10h10"/></svg>`;
    case "sparkles":
      return `<svg ${common}><path d="M12 2l1.5 5L19 9l-5.5 2L12 16l-1.5-5L5 9l5.5-2L12 2z"/><path d="M19 14l.8 2.6L22 18l-2.2 1.4L19 22l-.8-2.6L16 18l2.2-1.4L19 14z"/></svg>`;
    default:
      return `<svg ${common}><circle cx="12" cy="12" r="10"/></svg>`;
  }
}

function applyProfile(profile: AppConfig["ui_profile"], cfg: AppConfig): AppConfig {
  if (profile === "light") {
    return {
      ...cfg,
      ui_profile: "light",
      proxy_rotation_enabled: false,
      jsleak_block_webrtc: false,
      jsleak_block_mdns: false,
      jsleak_block_quic: false,
      fingerprint_strip_headers: true,
      fingerprint_strip_client_hints: false,
      dns_enforce: false,
    };
  }
  if (profile === "moderate") {
    return {
      ...cfg,
      ui_profile: "moderate",
      proxy_rotation_enabled: false,
      jsleak_block_webrtc: true,
      jsleak_block_mdns: true,
      jsleak_block_quic: false,
      fingerprint_strip_headers: true,
      fingerprint_strip_client_hints: true,
      dns_enforce: false,
    };
  }
  if (profile === "high") {
    return {
      ...cfg,
      ui_profile: "high",
      proxy_rotation_enabled: true,
      proxy_rotation_interval_sec: Math.max(600, cfg.proxy_rotation_interval_sec || 600),
      jsleak_block_webrtc: true,
      jsleak_block_mdns: true,
      jsleak_block_quic: true,
      fingerprint_strip_headers: true,
      fingerprint_strip_client_hints: true,
      dns_servers: cfg.dns_servers.length ? cfg.dns_servers : ["9.9.9.9", "149.112.112.112"],
    };
  }
  return { ...cfg, ui_profile: "custom" };
}

function render(state: HealthState) {
  const app = document.getElementById("app");
  if (!app) return;

  const statusColor = state.pythonOk && state.engineOk ? "ok" : state.pythonOk ? "warn" : "down";
  const maskedIp = state.maskedIp || "---.---.---.---";
  const killswitchLabel = state.killswitchEnabled
    ? "DISABLE KILL SWITCH"
    : killswitchArmed
      ? "CONFIRM KILL SWITCH"
      : "KILL SWITCH";
  const dnsServers = state.dnsServers.length ? state.dnsServers.join("  ") : "—";
  const tf = trafficFilter.trim().toLowerCase();
  const traffic = tf
    ? trafficHistory.filter((c) => {
        const hay = [
          c.proto,
          c.local,
          c.remote,
          c.remote_ip ?? "",
          c.remote_rdns ?? "",
          c.process_name ?? "",
          c.process_path ?? "",
          c.state ?? "",
          c.pid ? String(c.pid) : "",
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(tf);
      })
    : trafficHistory;
  const connectionCount = traffic.length;
  const connectionRows = traffic.slice(0, 220).map((c) => {
    const pid = c.pid ? String(c.pid) : "";
    const st = c.state ? c.state : "";
    const pname = c.process_name ? escapeText(c.process_name) : "";
    const rip = c.remote_ip ? escapeText(c.remote_ip) : "";
    const rdns = c.remote_rdns ? escapeText(c.remote_rdns) : "";
    const rclass = c.remote_class ? escapeText(c.remote_class) : "";
    const rlabel = rdns || rip || escapeText(c.remote);
    return `<tr><td>${escapeText(c.proto)}</td><td class="mono">${escapeText(c.local)}</td><td>${rlabel}<div class="muted mono" style="margin-top: 2px;">${rclass}</div></td><td>${escapeText(st)}</td><td class="mono">${pid}</td><td>${pname}</td></tr>`;
  });

  const view = activeView;
  const config = configDraft ?? state.config ?? null;
  const theme = (config?.ui_theme ?? "dark") as AppConfig["ui_theme"];
  document.documentElement.setAttribute("data-theme", theme === "black" ? "black" : theme === "contrast" ? "contrast" : "dark");
  const rotation = state.rotationStatus;
  const rotationRunning = Boolean(rotation?.running);
  const rotationEnabled = Boolean(config?.proxy_rotation_enabled);
  const rotationPool = (config?.proxy_rotation_pool ?? []).join("\n");
  const rotationInterval = String(config?.proxy_rotation_interval_sec ?? 900);
  const isolation = state.isolationStatus;
  const isolationEnabled = Boolean(isolation?.enabled);
  const isolationSupported = Boolean(isolation?.supported);
  const isolationBackend = isolation?.backend ?? "";
  const isolationRules = isolation?.rules ?? [];
  const processes = state.processes;
  const macAdapters = state.macAdapters;
  const jsLeak = state.jsLeakStatus;
  const jsLeakEnabled = Boolean(jsLeak?.enabled);
  const jsLeakSupported = Boolean(jsLeak?.supported);
  const blocked = new Set(state.trackerBlocks || []);
  const trackerItems = (() => {
    const tf = trackerFilter.trim().toLowerCase();
    const map = new Map<
      string,
      { ip: string; rdns: string; count: number; last_seen: string; processes: Set<string>; ports: Set<number> }
    >();
    for (const c of trafficHistory) {
      if (c.remote_class !== "public") continue;
      const ip = c.remote_ip || "";
      if (!ip) continue;
      const rdns = c.remote_rdns || "";
      const pidp = c.process_name || "";
      const port = typeof c.remote_port === "number" ? c.remote_port : 0;
      const key = ip;
      const it = map.get(key) ?? { ip, rdns, count: 0, last_seen: "", processes: new Set(), ports: new Set() };
      it.count += 1;
      if (!it.last_seen || c.seen_at > it.last_seen) it.last_seen = c.seen_at;
      if (pidp) it.processes.add(pidp);
      if (port) it.ports.add(port);
      if (!it.rdns && rdns) it.rdns = rdns;
      map.set(key, it);
    }
    let items = Array.from(map.values());
    if (tf) {
      items = items.filter((it) => {
        const hay = [it.ip, it.rdns, Array.from(it.processes).join(" "), Array.from(it.ports).join(" ")].join(" ").toLowerCase();
        return hay.includes(tf);
      });
    }
    items.sort((a, b) => b.count - a.count);
    return items.slice(0, 120);
  })();
  const logs = state.logs || [];
  const failover = state.failoverStatus;
  const failoverRunning = Boolean(failover?.running);
  const failoverEnabled = Boolean(config?.failover_enabled);
  const failoverInterval = String(config?.failover_check_interval_sec ?? 15);
  const failoverProbe = String(config?.failover_probe_host ?? "example.com:443");
  const failoverBackups = (config?.failover_backups ?? []).join("\n");
  const configPanel =
    view === "proxy"
      ? `
        <section class="panel">
          <div class="panel__title">PROXY CONFIG</div>
          <div class="panel__body">
            <div class="grid2">
              <div class="field">
                <div class="field__label">PROFILE</div>
                <select class="select" id="profile-select">
                  <option value="custom" ${(config?.ui_profile ?? "custom") === "custom" ? "selected" : ""}>CUSTOM</option>
                  <option value="light" ${(config?.ui_profile ?? "custom") === "light" ? "selected" : ""}>LIGHT</option>
                  <option value="moderate" ${(config?.ui_profile ?? "custom") === "moderate" ? "selected" : ""}>MODERATE</option>
                  <option value="high" ${(config?.ui_profile ?? "custom") === "high" ? "selected" : ""}>HIGH RISK</option>
                </select>
              </div>
              <div class="field">
                <div class="field__label">THEME</div>
                <div class="kv" style="border-bottom: 0; padding: 8px 0;">
                  <div class="kv__k">ACTIVE</div>
                  <div class="kv__v mono">${escapeText(theme.toUpperCase())}</div>
                </div>
              </div>
            </div>

            <div class="grid2">
              <div class="field">
                <div class="field__label">PROXY LISTEN</div>
                <input class="input" id="cfg-proxy-listen" value="${escapeAttr(config?.proxy_listen_addr ?? "")}" placeholder="127.0.0.1:18080" />
              </div>
              <div class="field">
                <div class="field__label">UPSTREAM (SINGLE)</div>
                <input class="input" id="cfg-upstream-single" value="${escapeAttr(config?.upstream_proxy_url ?? "")}" placeholder="http://user:pass@host:port" />
              </div>
            </div>

            <div class="field" style="margin-top: 12px;">
              <div class="field__label">UPSTREAM CHAIN</div>
              <div class="list" id="cfg-chain">
                ${(config?.upstream_proxy_chain ?? []).map((u, i) => {
                  const upDisabled = i === 0 ? "disabled" : "";
                  const downDisabled = i === (config?.upstream_proxy_chain ?? []).length - 1 ? "disabled" : "";
                  return `
                    <div class="listrow" data-index="${i}">
                      <input class="input input--row" data-chain-input="${i}" value="${escapeAttr(u)}" placeholder="http://host:port" />
                      <div class="rowbtns">
                        <button class="btn btn--mini" type="button" data-chain-up="${i}" ${upDisabled}>UP</button>
                        <button class="btn btn--mini" type="button" data-chain-down="${i}" ${downDisabled}>DOWN</button>
                        <button class="btn btn--mini" type="button" data-chain-del="${i}">DEL</button>
                      </div>
                    </div>
                  `;
                }).join("")}
                <div class="listrow">
                  <input class="input input--row" id="cfg-chain-new" value="" placeholder="http://host:port" />
                  <div class="rowbtns">
                    <button class="btn btn--mini" type="button" id="cfg-chain-add">ADD</button>
                  </div>
                </div>
              </div>
              <div class="hint">If CHAIN is non-empty it overrides SINGLE upstream.</div>
            </div>

            <div class="field" style="margin-top: 12px;">
              <div class="field__label">IP ROTATION</div>
              <div class="grid2">
                <div class="field">
                  <div class="field__label">ENABLED</div>
                  <button class="btn" type="button" id="rot-toggle">${rotationEnabled ? "ON" : "OFF"}</button>
                </div>
                <div class="field">
                  <div class="field__label">INTERVAL (SEC)</div>
                  <input class="input" id="rot-interval" value="${escapeAttr(rotationInterval)}" inputmode="numeric" />
                </div>
              </div>
              <div class="field" style="margin-top: 12px;">
                <div class="field__label">ROTATION POOL</div>
                <textarea class="textarea" id="rot-pool" rows="6" placeholder="one proxy URL per line">${escapeText(rotationPool)}</textarea>
                <div class="hint">Rotation restarts the proxy and switches upstream_proxy_url. Rotation is blocked when CHAIN is non-empty.</div>
              </div>

              ${rotation?.last_error ? `<div class="error">${escapeText(rotation.last_error)}</div>` : ""}
              <div class="kv" style="border-bottom: 0;">
                <div class="kv__k">RUNNING</div>
                <div class="kv__v">${rotationRunning ? "YES" : "NO"}</div>
              </div>
              <div class="kv" style="border-bottom: 0;">
                <div class="kv__k">NEXT</div>
                <div class="kv__v mono">${escapeText(rotation?.next_upstream ?? "")}</div>
              </div>

              <div class="actions">
                <button class="btn" type="button" id="rot-start">START ROTATION</button>
                <button class="btn" type="button" id="rot-stop">STOP ROTATION</button>
                <button class="btn" type="button" id="rot-now">ROTATE NOW</button>
              </div>
            </div>

            <div class="field" style="margin-top: 12px;">
              <div class="field__label">FAILOVER</div>
              <div class="grid2">
                <div class="field">
                  <div class="field__label">ENABLED</div>
                  <button class="btn" type="button" id="fo-toggle">${failoverEnabled ? "ON" : "OFF"}</button>
                </div>
                <div class="field">
                  <div class="field__label">INTERVAL (SEC)</div>
                  <input class="input" id="fo-interval" value="${escapeAttr(failoverInterval)}" inputmode="numeric" />
                </div>
              </div>
              <div class="grid2" style="margin-top: 12px;">
                <div class="field">
                  <div class="field__label">PROBE HOST</div>
                  <input class="input" id="fo-probe" value="${escapeAttr(failoverProbe)}" placeholder="example.com:443" />
                </div>
                <div class="field">
                  <div class="field__label">STATUS</div>
                  <div class="kv" style="border-bottom: 0; padding: 8px 0;">
                    <div class="kv__k">RUNNING</div>
                    <div class="kv__v">${failoverRunning ? "YES" : "NO"}</div>
                  </div>
                </div>
              </div>
              <div class="field" style="margin-top: 12px;">
                <div class="field__label">BACKUP UPSTREAMS</div>
                <textarea class="textarea" id="fo-backups" rows="5" placeholder="one proxy URL per line">${escapeText(failoverBackups)}</textarea>
                <div class="hint">Failover probes the local proxy by CONNECTing to PROBE HOST. On repeated failures, it swaps upstream_proxy_url to the next backup and restarts the proxy.</div>
              </div>

              ${failover?.last_error ? `<div class="error">${escapeText(failover.last_error)}</div>` : ""}
              <div class="kv" style="border-bottom: 0;">
                <div class="kv__k">FAILURES</div>
                <div class="kv__v mono">${String(failover?.consecutive_failures ?? 0)}</div>
              </div>

              <div class="actions">
                <button class="btn" type="button" id="fo-start">START MONITOR</button>
                <button class="btn" type="button" id="fo-stop">STOP MONITOR</button>
                <button class="btn" type="button" id="fo-trigger">TRIGGER</button>
              </div>
            </div>

            <div class="field" style="margin-top: 12px;">
              <div class="field__label">BROWSER AGENT</div>
              <div class="grid2">
                <div class="field">
                  <div class="field__label">USER AGENT</div>
                  <input class="input" id="fp-ua" value="${escapeAttr(config?.fingerprint_user_agent ?? "")}" placeholder="Override User-Agent for HTTP proxy traffic" />
                </div>
                <div class="field">
                  <div class="field__label">STRIP HEADERS</div>
                  <button class="btn" type="button" id="fp-strip">${config?.fingerprint_strip_headers ? "ON" : "OFF"}</button>
                </div>
              </div>
              <div class="hint">Applies to HTTP requests through the proxy (not HTTPS CONNECT payload). Strips Forwarded/Via/X-Forwarded-* when enabled.</div>
            </div>

            <div class="field" style="margin-top: 12px;">
              <div class="field__label">NETWORK + DEVICE AGENT</div>
              <div class="grid2">
                <div class="field">
                  <div class="field__label">ACCEPT-LANGUAGE</div>
                  <input class="input" id="fp-al" value="${escapeAttr(config?.fingerprint_accept_language ?? "")}" placeholder="e.g. en-US,en;q=0.9" />
                </div>
                <div class="field">
                  <div class="field__label">STRIP CLIENT HINTS</div>
                  <button class="btn" type="button" id="fp-ch">${config?.fingerprint_strip_client_hints ? "ON" : "OFF"}</button>
                </div>
              </div>
              <div class="hint">Client Hints are Sec-CH-UA* and similar headers. These changes only apply to HTTP proxy traffic.</div>
            </div>

            ${configError ? `<div class="error">${escapeText(configError)}</div>` : ""}

            <div class="actions">
              <button class="btn" type="button" id="cfg-reload">RELOAD</button>
              <button class="btn" type="button" id="cfg-save" ${configSaving ? "disabled" : ""}>${configSaving ? "SAVING..." : "SAVE"}</button>
              <button class="btn" type="button" id="cfg-save-start" ${configSaving ? "disabled" : ""}>${configSaving ? "SAVING..." : "SAVE & START"}</button>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel__title">CIRCUIT ISOLATION</div>
          <div class="panel__body">
            <div class="kv">
              <div class="kv__k">BACKEND</div>
              <div class="kv__v mono">${escapeText(isolationBackend)}</div>
            </div>
            <div class="kv">
              <div class="kv__k">SUPPORTED</div>
              <div class="kv__v">${isolationSupported ? "YES" : "NO"}</div>
            </div>
            <div class="kv">
              <div class="kv__k">ENABLED</div>
              <div class="kv__v">${isolationEnabled ? "YES" : "NO"}</div>
            </div>

            <div class="hint">${
              isolationBackend === "firewall"
                ? "Firewall enforcement blocks all outbound traffic for the selected app except to its assigned local proxy."
                : "WinDivert backend is selected. If WinDivert isn’t installed, SUPPORTED will be NO."
            }</div>

            <div class="tablewrap" style="max-height: 220px; margin-top: 12px;">
              <table class="table">
                <thead>
                  <tr><th>PID</th><th>PROCESS</th><th></th></tr>
                </thead>
                <tbody>
                  ${processes.slice(0, 20).map((p) => {
                    return `<tr><td>${p.pid}</td><td>${escapeText(p.name)}</td><td><button class="btn btn--mini" type="button" data-usepid="${p.pid}">USE</button></td></tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>

            <div class="grid2" style="margin-top: 12px;">
              <div class="field">
                <div class="field__label">PID</div>
                <input class="input" id="iso-pid" value="" inputmode="numeric" placeholder="e.g. 1234" />
              </div>
              <div class="field">
                <div class="field__label">CIRCUIT ID</div>
                <input class="input" id="iso-circuit" value="" placeholder="e.g. app-1" />
              </div>
            </div>
            <div class="field" style="margin-top: 12px;">
              <div class="field__label">LOCAL PROXY ADDR</div>
              <input class="input" id="iso-proxyaddr" value="${escapeAttr(config?.proxy_listen_addr ?? "127.0.0.1:18080")}" placeholder="127.0.0.1:18080" />
            </div>

            <div class="actions">
              <button class="btn" type="button" id="iso-add">ADD RULE</button>
              <button class="btn" type="button" id="iso-enable">ENABLE</button>
              <button class="btn" type="button" id="iso-disable">DISABLE</button>
            </div>

            <div class="tablewrap" style="max-height: 220px;">
              <table class="table">
                <thead>
                  <tr><th>PID</th><th>CIRCUIT</th><th>PROXY</th><th>ENF</th><th>ERR</th></tr>
                </thead>
                <tbody>
                  ${isolationRules.map((r) => {
                    const err = r.last_error ? escapeText(r.last_error) : "";
                    return `<tr><td>${r.pid}</td><td>${escapeText(r.circuit_id)}</td><td>${escapeText(r.proxy_addr)}</td><td>${r.enforced ? "Y" : "N"}</td><td>${err}</td></tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      `
      : "";

  const dnsPanel =
    view === "dns"
      ? `
        <section class="panel">
          <div class="panel__title">DNS MANAGEMENT</div>
          <div class="panel__body">
            <div class="kv">
              <div class="kv__k">SERVERS</div>
              <div class="kv__v mono">${dnsServers}</div>
            </div>

            <div class="field" style="margin-top: 12px;">
              <div class="field__label">INTERFACE</div>
              <select class="select" id="dns-iface">
                ${(state.dnsInterfaces || []).map((it) => {
                  const label = `${it.name}  ${it.status || ""}`;
                  const selected = (config?.dns_interface_name ?? "") === it.name ? "selected" : "";
                  return `<option value="${escapeAttr(it.name)}" ${selected}>${escapeText(label)}</option>`;
                }).join("")}
              </select>
              <div class="hint">Sets system DNS servers for the selected interface.</div>
            </div>

            <div class="field" style="margin-top: 12px;">
              <div class="field__label">DNS SERVERS</div>
              <textarea class="textarea" id="dns-servers" rows="4" placeholder="one IPv4 per line">${escapeText((config?.dns_servers ?? []).join("\n"))}</textarea>
              <div class="actions">
                <button class="btn btn--mini" type="button" data-dns-preset="cloudflare">CLOUDFLARE</button>
                <button class="btn btn--mini" type="button" data-dns-preset="google">GOOGLE</button>
                <button class="btn btn--mini" type="button" data-dns-preset="quad9">QUAD9</button>
              </div>
            </div>

            <div class="grid2" style="margin-top: 12px;">
              <div class="field">
                <div class="field__label">APPLY SERVERS</div>
                <button class="btn" type="button" id="dns-apply">${dnsApplyArmed ? "CONFIRM APPLY" : "APPLY"}</button>
              </div>
              <div class="field">
                <div class="field__label">FLUSH CACHE</div>
                <button class="btn" type="button" id="dns-flush">FLUSH</button>
              </div>
            </div>

            <div class="field" style="margin-top: 12px;">
              <div class="field__label">SECURE DNS ENFORCEMENT</div>
              <div class="kv" style="border-bottom: 0;">
                <div class="kv__k">ENABLED</div>
                <div class="kv__v">${state.dnsEnforce?.enabled ? "YES" : "NO"}</div>
              </div>
              <div class="kv" style="border-bottom: 0;">
                <div class="kv__k">ALLOWED</div>
                <div class="kv__v mono">${escapeText((state.dnsEnforce?.servers ?? []).join("  "))}</div>
              </div>
              <div class="hint">Adds firewall rules (group KavehDNS) to allow DNS only to the configured servers (TCP/UDP 53) and block all other DNS.</div>
              <div class="actions">
                <button class="btn" type="button" id="dns-enforce">${dnsEnforceArmed ? "CONFIRM ENFORCE" : "ENFORCE"}</button>
                <button class="btn" type="button" id="dns-unenforce">${dnsUnenforceArmed ? "CONFIRM DISABLE" : "DISABLE"}</button>
              </div>
            </div>
          </div>
        </section>
      `
      : "";

  const monitorPanel =
    view === "dashboard"
      ? `
        <section class="panel">
          <div class="panel__title">LIVE CONNECTIONS</div>
          <div class="panel__body">
            <div class="grid2">
              <div class="kv" style="border-bottom: 0;">
                <div class="kv__k">COUNT</div>
                <div class="kv__v" id="conn-count">${connectionCount}</div>
              </div>
              <div class="kv" style="border-bottom: 0;">
                <div class="kv__k">LAST</div>
                <div class="kv__v mono" id="conn-last">${escapeText(state.monitorTakenAt || "")}</div>
              </div>
            </div>
            <div class="grid2" style="margin-top: 12px;">
              <div class="field">
                <div class="field__label">FILTER</div>
                <input class="input" id="traffic-filter" value="${escapeAttr(trafficFilter)}" placeholder="pid / domain / ip / process" />
              </div>
              <div class="field">
                <div class="field__label">ACTIONS</div>
                <div class="actions">
                  <button class="btn" type="button" id="traffic-pause">${trafficPaused ? "RESUME" : "PAUSE"}</button>
                  <button class="btn" type="button" id="traffic-clear">CLEAR</button>
                </div>
              </div>
            </div>

            <div class="tablewrap" style="max-height: 520px; margin-top: 12px;">
              <table class="table">
                <thead>
                  <tr><th>PROTO</th><th>LOCAL</th><th>REMOTE</th><th>STATE</th><th>PID</th><th>PROCESS</th></tr>
                </thead>
                <tbody id="conn-tbody">
                  ${connectionRows.join("")}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      `
      : "";

  const fingerprintPanel =
    view === "fingerprint"
      ? `
        <section class="panel">
          <div class="panel__title">MAC ADDRESS</div>
          <div class="panel__body">
            <div class="hint">Spoofing MAC will briefly disconnect networking. Requires Administrator privileges.</div>

            <div class="field" style="margin-top: 12px;">
              <div class="field__label">ADAPTER</div>
              <select class="select" id="mac-adapter">
                ${macAdapters.map((a) => {
                  const label = `${a.name}  (${a.mac_address || "—"})  ${a.status || ""}`;
                  const selected = macSelectedAdapter === a.name ? "selected" : "";
                  return `<option value="${escapeAttr(a.name)}" ${selected}>${escapeText(label)}</option>`;
                }).join("")}
              </select>
            </div>

            <div class="grid2" style="margin-top: 12px;">
              <div class="field">
                <div class="field__label">CUSTOM MAC (LAA, UNICAST)</div>
                <input class="input" id="mac-custom" value="${escapeAttr(macCustom)}" placeholder="e.g. 02A1B2C3D4E5" />
              </div>
              <div class="field">
                <div class="field__label">ACTIONS</div>
                <div class="actions">
                  <button class="btn" type="button" id="mac-random">${macSpoofArmed ? "CONFIRM SPOOF" : "SPOOF RANDOM"}</button>
                  <button class="btn" type="button" id="mac-custom-btn">${macSpoofArmed ? "CONFIRM SPOOF" : "SPOOF CUSTOM"}</button>
                  <button class="btn" type="button" id="mac-reset">${macResetArmed ? "CONFIRM RESET" : "RESET"}</button>
                </div>
              </div>
            </div>

            <div class="tablewrap" style="margin-top: 12px;">
              <table class="table">
                <thead>
                  <tr><th>NAME</th><th>MAC</th><th>STATUS</th><th>IF</th></tr>
                </thead>
                <tbody>
                  ${macAdapters.map((a) => {
                    return `<tr><td>${escapeText(a.name)}</td><td class="mono">${escapeText(a.mac_address || "")}</td><td>${escapeText(a.status || "")}</td><td>${a.if_index ?? ""}</td></tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel__title">JS LEAK PROTECTION</div>
          <div class="panel__body">
            <div class="hint">Adds Windows Firewall outbound block rules to reduce WebRTC / QUIC based IP leaks. Requires Administrator privileges.</div>

            <div class="kv">
              <div class="kv__k">SUPPORTED</div>
              <div class="kv__v">${jsLeakSupported ? "YES" : "NO"}</div>
            </div>
            <div class="kv">
              <div class="kv__k">ENABLED</div>
              <div class="kv__v">${jsLeakEnabled ? "YES" : "NO"}</div>
            </div>

            <div class="grid2" style="margin-top: 12px;">
              <div class="field">
                <div class="field__label">BLOCK WEBRTC (STUN)</div>
                <button class="btn" type="button" id="jsl-webrtc">${config?.jsleak_block_webrtc ? "ON" : "OFF"}</button>
              </div>
              <div class="field">
                <div class="field__label">BLOCK mDNS</div>
                <button class="btn" type="button" id="jsl-mdns">${config?.jsleak_block_mdns ? "ON" : "OFF"}</button>
              </div>
            </div>
            <div class="grid2" style="margin-top: 12px;">
              <div class="field">
                <div class="field__label">BLOCK QUIC (UDP 443)</div>
                <button class="btn" type="button" id="jsl-quic">${config?.jsleak_block_quic ? "ON" : "OFF"}</button>
              </div>
              <div class="field">
                <div class="field__label">ACTIONS</div>
                <div class="actions">
                  <button class="btn" type="button" id="jsl-enable">${jsLeakEnableArmed ? "CONFIRM ENABLE" : "ENABLE"}</button>
                  <button class="btn" type="button" id="jsl-disable">${jsLeakDisableArmed ? "CONFIRM DISABLE" : "DISABLE"}</button>
                </div>
              </div>
            </div>
          </div>
        </section>
      `
      : "";

  const trackerPanel =
    view === "tracker"
      ? `
        <section class="panel">
          <div class="panel__title">TRACKER VISIBILITY</div>
          <div class="panel__body">
            <div class="hint">Derived from recent public remote IP connections. Blocking adds outbound firewall rules (group KavehTracker).</div>

            <div class="grid2" style="margin-top: 12px;">
              <div class="field">
                <div class="field__label">FILTER</div>
                <input class="input" id="trk-filter" value="${escapeAttr(trackerFilter)}" placeholder="ip / domain / process / port" />
              </div>
              <div class="field">
                <div class="field__label">ACTIONS</div>
                <div class="actions">
                  <button class="btn" type="button" id="trk-clear">${trackerClearArmed ? "CONFIRM CLEAR" : "CLEAR BLOCKS"}</button>
                </div>
              </div>
            </div>

            <div class="tablewrap" style="max-height: 520px; margin-top: 12px;">
              <table class="table">
                <thead>
                  <tr><th>REMOTE</th><th>HITS</th><th>LAST</th><th>PORTS</th><th>PROCESS</th><th></th></tr>
                </thead>
                <tbody>
                  ${trackerItems.map((it) => {
                    const label = it.rdns ? `${it.rdns}  (${it.ip})` : it.ip;
                    const ports = Array.from(it.ports).slice(0, 4).join(",");
                    const proc = Array.from(it.processes).slice(0, 2).join(", ");
                    const isBlocked = blocked.has(it.ip);
                    const action: "block" | "unblock" = isBlocked ? "unblock" : "block";
                    const armed = trackerArmedIp === it.ip && trackerArmedAction === action;
                    const btn = isBlocked
                      ? `<button class="btn btn--mini" type="button" data-trk-act="unblock" data-trk-ip="${escapeAttr(it.ip)}">${armed ? "CONFIRM UNBLOCK" : "UNBLOCK"}</button>`
                      : `<button class="btn btn--mini" type="button" data-trk-act="block" data-trk-ip="${escapeAttr(it.ip)}">${armed ? "CONFIRM BLOCK" : "BLOCK"}</button>`;
                    return `<tr>
                      <td class="mono">${escapeText(label)}</td>
                      <td class="mono">${it.count}</td>
                      <td class="mono muted">${escapeText(it.last_seen)}</td>
                      <td class="mono">${escapeText(ports)}</td>
                      <td>${escapeText(proc)}</td>
                      <td>${btn}</td>
                    </tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      `
      : "";

  const logsPanel =
    view === "logs"
      ? `
        <section class="panel">
          <div class="panel__title">AUDIT LOGS</div>
          <div class="panel__body">
            <div class="grid2">
              <div class="field">
                <div class="field__label">FILTER</div>
                <input class="input" id="log-filter" value="${escapeAttr(logsFilter)}" placeholder="type / message" />
              </div>
              <div class="field">
                <div class="field__label">ACTIONS</div>
                <div class="actions">
                  <button class="btn" type="button" id="log-refresh">REFRESH</button>
                  <button class="btn" type="button" id="log-clear">CLEAR</button>
                  <button class="btn" type="button" id="log-export">EXPORT</button>
                </div>
              </div>
            </div>

            <div class="tablewrap" style="max-height: 560px; margin-top: 12px;">
              <table class="table">
                <thead>
                  <tr><th>TS</th><th>LEVEL</th><th>TYPE</th><th>MESSAGE</th></tr>
                </thead>
                <tbody>
                  ${(() => {
                    const tf = logsFilter.trim().toLowerCase();
                    const rows = tf
                      ? logs.filter((l) => `${l.type} ${l.message}`.toLowerCase().includes(tf))
                      : logs;
                    return rows.slice(0, 240).map((l) => {
                      const cls = l.level === "crit" ? "danger" : l.level === "warn" ? "warn" : "ok";
                      return `<tr>
                        <td class="mono muted">${escapeText(l.ts)}</td>
                        <td class="mono ${cls}">${escapeText(l.level.toUpperCase())}</td>
                        <td class="mono">${escapeText(l.type)}</td>
                        <td>${escapeText(l.message)}</td>
                      </tr>`;
                    }).join("");
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      `
      : "";

  const onboardingPanel =
    view === "onboarding"
      ? `
        <section class="panel">
          <div class="panel__title">ONBOARDING</div>
          <div class="panel__body">
            <div class="kv" style="border-bottom: 0;">
              <div class="kv__k">STEP</div>
              <div class="kv__v mono">${onboardingStep} / 3</div>
            </div>

            ${
              onboardingStep === 1
                ? `
                  <div class="hint">Configure your proxy and start the session. You can change anything later.</div>
                  <div class="grid2" style="margin-top: 12px;">
                    <div class="field">
                      <div class="field__label">PROXY LISTEN</div>
                      <input class="input" id="ob-listen" value="${escapeAttr(config?.proxy_listen_addr ?? "127.0.0.1:18080")}" />
                    </div>
                    <div class="field">
                      <div class="field__label">UPSTREAM (OPTIONAL)</div>
                      <input class="input" id="ob-upstream" value="${escapeAttr(config?.upstream_proxy_url ?? "")}" placeholder="http://user:pass@host:port" />
                    </div>
                  </div>
                  <div class="actions">
                    <button class="btn" type="button" id="ob-save">SAVE</button>
                    <button class="btn" type="button" id="ob-save-start">SAVE & START</button>
                    <button class="btn" type="button" id="ob-next">NEXT</button>
                  </div>
                `
                : onboardingStep === 2
                  ? `
                    <div class="hint">Choose a threat profile. This sets safe defaults for leak protection.</div>
                    <div class="grid2" style="margin-top: 12px;">
                      <button class="btn" type="button" data-ob-prof="light">LIGHT</button>
                      <button class="btn" type="button" data-ob-prof="moderate">MODERATE</button>
                      <button class="btn" type="button" data-ob-prof="high">HIGH RISK</button>
                      <button class="btn" type="button" data-ob-prof="custom">CUSTOM</button>
                    </div>
                    <div class="kv" style="margin-top: 12px;">
                      <div class="kv__k">CURRENT</div>
                      <div class="kv__v mono">${escapeText(config?.ui_profile ?? "custom")}</div>
                    </div>
                    <div class="actions">
                      <button class="btn" type="button" id="ob-back">BACK</button>
                      <button class="btn" type="button" id="ob-next">NEXT</button>
                    </div>
                  `
                  : `
                    <div class="hint">You’re ready. Use shortcuts for speed and safety.</div>
                    <div class="tablewrap" style="margin-top: 12px;">
                      <table class="table">
                        <thead><tr><th>KEY</th><th>ACTION</th></tr></thead>
                        <tbody>
                          <tr><td class="mono">CTRL+SHIFT+K</td><td>Kill switch toggle</td></tr>
                          <tr><td class="mono">CTRL+P</td><td>Proxy start/stop toggle</td></tr>
                          <tr><td class="mono">CTRL+1..6</td><td>Navigate views</td></tr>
                          <tr><td class="mono">ESC</td><td>Cancel armed actions</td></tr>
                        </tbody>
                      </table>
                    </div>
                    <div class="actions">
                      <button class="btn" type="button" id="ob-back">BACK</button>
                      <button class="btn" type="button" id="ob-finish">GO TO DASHBOARD</button>
                    </div>
                  `
            }
          </div>
        </section>
      `
      : "";

  const actionBanner =
    actionMsg && Date.now() - actionAt < 15000
      ? `<div class="${actionError ? "error" : "hint"}">${escapeText(actionMsg)}</div>`
      : "";

  app.innerHTML = `
    <div class="kaveh-shell">
      <header class="topbar">
        <div class="topbar__left">
          <div class="brand">KAVEH</div>
        </div>

        <nav class="topbar__nav" aria-label="Primary">
          <button class="navbtn ${view === "dashboard" ? "is-active" : ""}" type="button" data-nav="dashboard" title="DASHBOARD">
            ${lucideIcon("layout-dashboard")}
            <span class="navbtn__label">DASHBOARD</span>
          </button>
          <button class="navbtn ${view === "proxy" ? "is-active" : ""}" type="button" data-nav="proxy" title="PROXY">
            ${lucideIcon("shield")}
            <span class="navbtn__label">PROXY</span>
          </button>
          <button class="navbtn ${view === "dns" ? "is-active" : ""}" type="button" data-nav="dns" title="DNS">
            ${lucideIcon("globe")}
            <span class="navbtn__label">DNS</span>
          </button>
          <button class="navbtn ${view === "fingerprint" ? "is-active" : ""}" type="button" data-nav="fingerprint" title="FINGERPRINT">
            ${lucideIcon("fingerprint")}
            <span class="navbtn__label">FINGERPRINT</span>
          </button>
          <button class="navbtn ${view === "tracker" ? "is-active" : ""}" type="button" data-nav="tracker" title="TRACKER">
            ${lucideIcon("radar")}
            <span class="navbtn__label">TRACKER</span>
          </button>
          <button class="navbtn ${view === "logs" ? "is-active" : ""}" type="button" data-nav="logs" title="LOGS">
            ${lucideIcon("scroll-text")}
            <span class="navbtn__label">LOGS</span>
          </button>
          <button class="navbtn ${view === "onboarding" ? "is-active" : ""}" type="button" data-nav="onboarding" title="ONBOARD">
            ${lucideIcon("sparkles")}
            <span class="navbtn__label">ONBOARD</span>
          </button>
        </nav>

        <div class="topbar__right">
          <select class="select" id="theme-select" aria-label="Theme">
            <option value="dark" ${theme === "dark" ? "selected" : ""}>DARK</option>
            <option value="contrast" ${theme === "contrast" ? "selected" : ""}>CONTRAST</option>
            <option value="black" ${theme === "black" ? "selected" : ""}>PURE BLACK</option>
          </select>
          <div class="status">
            <span class="statusdot statusdot--${statusColor}" id="statusdot"></span>
            <span class="status__ip" id="masked-ip">MASKED IP ${maskedIp}</span>
          </div>
          <button class="killswitch" type="button" id="killswitch-btn">${killswitchLabel}</button>
        </div>
      </header>

      <main class="workspace">
        ${actionBanner}
        <section class="panel ${view !== "dashboard" ? "is-hidden" : ""}">
          <div class="panel__title">SYSTEM STATUS</div>
          <div class="panel__body">
            <div class="kv">
              <div class="kv__k">PYTHON API</div>
              <div class="kv__v" id="status-python">${state.pythonOk ? "ONLINE" : "OFFLINE"}</div>
            </div>
            <div class="kv">
              <div class="kv__k">GO ENGINE</div>
              <div class="kv__v" id="status-engine">${state.engineOk ? "ONLINE" : "OFFLINE"}</div>
            </div>
            <div class="kv">
              <div class="kv__k">PROXY</div>
              <div class="kv__v" id="status-proxy">${state.proxyRunning ? "RUNNING" : "STOPPED"}</div>
            </div>
            <div class="kv">
              <div class="kv__k">KILL SWITCH</div>
              <div class="kv__v" id="status-ks">${state.killswitchEnabled ? "ENABLED" : "DISABLED"}</div>
            </div>

            <div class="actions">
              <button class="btn" type="button" id="proxy-start">START PROXY</button>
              <button class="btn" type="button" id="proxy-stop">STOP PROXY</button>
            </div>
          </div>
        </section>
        ${monitorPanel}
        ${dnsPanel}
        ${fingerprintPanel}
        ${trackerPanel}
        ${logsPanel}
        ${onboardingPanel}
        ${configPanel}
      </main>
    </div>
  `;

  document.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-nav") as ViewKey | null;
      if (!next) return;
      activeView = next;
      setAction(`View: ${next.toUpperCase()}`, false);
      render(state);
    });
  });

  const themeSel = document.getElementById("theme-select") as HTMLSelectElement | null;
  themeSel?.addEventListener("change", async () => {
    const draft = ensureConfigDraft(state.config, {});
    configDraft = { ...draft, ui_theme: (themeSel.value as AppConfig["ui_theme"]) || "dark" };
    await saveConfig(state.config);
  });

  const startBtn = document.getElementById("proxy-start");
  const stopBtn = document.getElementById("proxy-stop");
  startBtn?.addEventListener("click", async () => {
    setAction("Starting proxy...", false);
    const r = await apiJson<Record<string, unknown>>("/engine/proxy/start", { method: "POST" });
    if (!r.ok) setAction(`Proxy start failed: ${r.error}`, true);
    else setAction("Proxy start requested.", false);
    await refreshNow(false);
  });
  stopBtn?.addEventListener("click", async () => {
    setAction("Stopping proxy...", false);
    const r = await apiJson<Record<string, unknown>>("/engine/proxy/stop", { method: "POST" });
    if (!r.ok) setAction(`Proxy stop failed: ${r.error}`, true);
    else setAction("Proxy stop requested.", false);
    await refreshNow(false);
  });

  if (view === "dns") {
    const ifaceSel = document.getElementById("dns-iface") as HTMLSelectElement | null;
    ifaceSel?.addEventListener("change", () => {
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, dns_interface_name: ifaceSel.value };
    });

    const serversEl = document.getElementById("dns-servers") as HTMLTextAreaElement | null;
    serversEl?.addEventListener("input", () => {
      const lines = (serversEl.value || "")
        .split(/\r?\n/g)
        .map((x) => x.trim())
        .filter(Boolean);
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, dns_servers: lines };
    });

    document.querySelectorAll<HTMLButtonElement>("[data-dns-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const p = btn.getAttribute("data-dns-preset") || "";
        const servers =
          p === "cloudflare" ? ["1.1.1.1", "1.0.0.1"] : p === "google" ? ["8.8.8.8", "8.8.4.4"] : ["9.9.9.9", "149.112.112.112"];
        const draft = ensureConfigDraft(state.config, {});
        configDraft = { ...draft, dns_servers: servers };
        render(state);
      });
    });

    const flushBtn = document.getElementById("dns-flush");
    flushBtn?.addEventListener("click", async () => {
      setAction("Flushing DNS cache...", false);
      const r = await apiPost("/engine/dns/flush");
      if (!r.ok) setAction(`DNS flush failed: ${r.error}`, true);
      else setAction("DNS flush requested.", false);
      await refreshNow(false);
    });

    const applyBtn = document.getElementById("dns-apply");
    applyBtn?.addEventListener("click", async () => {
      if (!dnsApplyArmed) {
        dnsApplyArmed = true;
        dnsEnforceArmed = false;
        dnsUnenforceArmed = false;
        render(state);
        return;
      }
      dnsApplyArmed = false;
      const cfg = normalizeConfig(configDraft ?? state.config ?? defaultConfig());
      setAction("Applying DNS servers...", false);
      const r = await apiPost("/engine/dns/set", { interface_name: cfg.dns_interface_name, servers: cfg.dns_servers });
      if (!r.ok) setAction(`DNS apply failed: ${r.error}`, true);
      else setAction("DNS apply requested.", false);
      await refreshNow(false);
    });

    const enforceBtn = document.getElementById("dns-enforce");
    enforceBtn?.addEventListener("click", async () => {
      if (!dnsEnforceArmed) {
        dnsEnforceArmed = true;
        dnsApplyArmed = false;
        dnsUnenforceArmed = false;
        render(state);
        return;
      }
      dnsEnforceArmed = false;
      const cfg = normalizeConfig(configDraft ?? state.config ?? defaultConfig());
      setAction("Enforcing DNS...", false);
      const r = await apiPost("/engine/dns/enforce", { servers: cfg.dns_servers });
      if (!r.ok) setAction(`DNS enforce failed: ${r.error}`, true);
      else setAction("DNS enforce requested.", false);
      await refreshNow(false);
    });

    const unenforceBtn = document.getElementById("dns-unenforce");
    unenforceBtn?.addEventListener("click", async () => {
      if (!dnsUnenforceArmed) {
        dnsUnenforceArmed = true;
        dnsApplyArmed = false;
        dnsEnforceArmed = false;
        render(state);
        return;
      }
      dnsUnenforceArmed = false;
      setAction("Disabling DNS enforcement...", false);
      const r = await apiPost("/engine/dns/unenforce", {});
      if (!r.ok) setAction(`DNS unenforce failed: ${r.error}`, true);
      else setAction("DNS unenforce requested.", false);
      await refreshNow(false);
    });
  }

  const ksBtn = document.getElementById("killswitch-btn");
  ksBtn?.addEventListener("click", async () => {
    if (state.killswitchEnabled) {
      killswitchArmed = false;
      setAction("Disabling kill switch...", false);
      const r = await apiJson<Record<string, unknown>>("/engine/killswitch/disable", { method: "POST" });
      if (!r.ok) setAction(`Kill switch disable failed: ${r.error}`, true);
      else setAction("Kill switch disable requested.", false);
      await refreshNow(false);
      return;
    }

    if (!killswitchArmed) {
      killswitchArmed = true;
      patch(state);
      return;
    }

    killswitchArmed = false;
    setAction("Enabling kill switch...", false);
    const r = await apiJson<Record<string, unknown>>("/engine/killswitch/enable", { method: "POST" });
    if (!r.ok) setAction(`Kill switch enable failed: ${r.error}`, true);
    else setAction("Kill switch enable requested.", false);
    await refreshNow(false);
  });

  if (view === "dashboard") {
    const filterEl = document.getElementById("traffic-filter") as HTMLInputElement | null;
    filterEl?.addEventListener("input", () => {
      trafficFilter = filterEl.value;
      render(state);
    });
    const pauseEl = document.getElementById("traffic-pause");
    pauseEl?.addEventListener("click", () => {
      trafficPaused = !trafficPaused;
      render(state);
    });
    const clearEl = document.getElementById("traffic-clear");
    clearEl?.addEventListener("click", () => {
      trafficHistory = [];
      render(state);
    });
  }

  if (view === "tracker") {
    const filterEl = document.getElementById("trk-filter") as HTMLInputElement | null;
    filterEl?.addEventListener("input", () => {
      trackerFilter = filterEl.value;
      render(state);
    });

    document.querySelectorAll<HTMLButtonElement>("[data-trk-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const act = (btn.getAttribute("data-trk-act") as "block" | "unblock" | null) ?? "";
        const ip = btn.getAttribute("data-trk-ip") ?? "";
        if (!act || !ip) return;
        if (trackerArmedIp !== ip || trackerArmedAction !== act) {
          trackerArmedIp = ip;
          trackerArmedAction = act;
          trackerClearArmed = false;
          render(state);
          return;
        }
        trackerArmedIp = "";
        trackerArmedAction = "";
        setAction(act === "block" ? `Blocking ${ip}...` : `Unblocking ${ip}...`, false);
        const r = await apiPost(act === "block" ? "/engine/monitor/block" : "/engine/monitor/unblock", { remote_ip: ip });
        if (!r.ok) setAction(`Tracker ${act} failed: ${r.error}`, true);
        else setAction(`Tracker ${act} requested for ${ip}.`, false);
        await refreshNow(false);
      });
    });

    const clearBtn = document.getElementById("trk-clear");
    clearBtn?.addEventListener("click", async () => {
      if (!trackerClearArmed) {
        trackerClearArmed = true;
        trackerArmedIp = "";
        trackerArmedAction = "";
        render(state);
        return;
      }
      trackerClearArmed = false;
      setAction("Clearing tracker blocks...", false);
      const r = await apiPost("/engine/monitor/clear_blocks", {});
      if (!r.ok) setAction(`Clear blocks failed: ${r.error}`, true);
      else setAction("Clear blocks requested.", false);
      await refreshNow(false);
    });
  }

  if (view === "logs") {
    const filterEl = document.getElementById("log-filter") as HTMLInputElement | null;
    filterEl?.addEventListener("input", () => {
      logsFilter = filterEl.value;
      render(state);
    });
    const refreshBtn = document.getElementById("log-refresh");
    refreshBtn?.addEventListener("click", async () => {
      setAction("Refreshing logs...", false);
      await refreshNow(false);
    });
    const clearBtn = document.getElementById("log-clear");
    clearBtn?.addEventListener("click", async () => {
      setAction("Clearing logs...", false);
      const r = await apiPost("/logs/clear", { confirm: true });
      if (!r.ok) setAction(`Log clear failed: ${r.error}`, true);
      else setAction("Log clear requested.", false);
      await refreshNow(false);
    });
    const exportBtn = document.getElementById("log-export");
    exportBtn?.addEventListener("click", () => {
      const lines = (state.logs || []).map((l) => `${l.ts}\t${l.level}\t${l.type}\t${l.message}`).join("\n");
      const blob = new Blob([lines], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "kaveh-audit.txt";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  if (view === "onboarding") {
    const nextBtn = document.getElementById("ob-next");
    const backBtn = document.getElementById("ob-back");
    const finishBtn = document.getElementById("ob-finish");

    nextBtn?.addEventListener("click", () => {
      onboardingStep = onboardingStep === 1 ? 2 : 3;
      render(state);
    });
    backBtn?.addEventListener("click", () => {
      onboardingStep = onboardingStep === 3 ? 2 : 1;
      render(state);
    });
    finishBtn?.addEventListener("click", () => {
      onboardingStep = 1;
      activeView = "dashboard";
      render(state);
    });

    const obListen = document.getElementById("ob-listen") as HTMLInputElement | null;
    const obUpstream = document.getElementById("ob-upstream") as HTMLInputElement | null;
    obListen?.addEventListener("input", () => {
      configDraft = ensureConfigDraft(state.config, { proxy_listen_addr: obListen.value });
    });
    obUpstream?.addEventListener("input", () => {
      configDraft = ensureConfigDraft(state.config, { upstream_proxy_url: obUpstream.value });
    });

    const obSave = document.getElementById("ob-save");
    obSave?.addEventListener("click", async () => {
      await saveConfig(state.config);
    });
    const obSaveStart = document.getElementById("ob-save-start");
    obSaveStart?.addEventListener("click", async () => {
      const ok = await saveConfig(state.config);
      if (ok) {
        setAction("Starting proxy...", false);
        const r = await apiPost("/engine/proxy/start");
        if (!r.ok) setAction(`Proxy start failed: ${r.error}`, true);
        else setAction("Proxy start requested.", false);
        await refreshNow(false);
      }
    });

    document.querySelectorAll<HTMLButtonElement>("[data-ob-prof]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const p = (btn.getAttribute("data-ob-prof") as AppConfig["ui_profile"] | null) ?? "custom";
        const base = normalizeConfig(configDraft ?? state.config ?? defaultConfig());
        configDraft = applyProfile(p, base);
        await saveConfig(state.config);
        render(state);
      });
    });
  }

  if (view === "proxy") {
    const profileSel = document.getElementById("profile-select") as HTMLSelectElement | null;
    profileSel?.addEventListener("change", async () => {
      const p = (profileSel.value as AppConfig["ui_profile"]) || "custom";
      const base = normalizeConfig(configDraft ?? state.config ?? defaultConfig());
      configDraft = applyProfile(p, base);
      await saveConfig(state.config);
      render(state);
    });

    const listen = document.getElementById("cfg-proxy-listen") as HTMLInputElement | null;
    const upstreamSingle = document.getElementById("cfg-upstream-single") as HTMLInputElement | null;
    listen?.addEventListener("input", () => {
      configDraft = ensureConfigDraft(state.config, { proxy_listen_addr: listen.value });
    });
    upstreamSingle?.addEventListener("input", () => {
      configDraft = ensureConfigDraft(state.config, { upstream_proxy_url: upstreamSingle.value });
    });

    document.querySelectorAll<HTMLInputElement>("[data-chain-input]").forEach((input) => {
      input.addEventListener("input", () => {
        const idx = Number(input.getAttribute("data-chain-input") || "-1");
        if (idx < 0) return;
        const draft = ensureConfigDraft(state.config, {});
        const next = [...draft.upstream_proxy_chain];
        next[idx] = input.value;
        configDraft = { ...draft, upstream_proxy_chain: next };
      });
    });

    document.querySelectorAll<HTMLButtonElement>("[data-chain-up]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-chain-up") || "-1");
        if (idx <= 0) return;
        const draft = ensureConfigDraft(state.config, {});
        const next = [...draft.upstream_proxy_chain];
        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
        configDraft = { ...draft, upstream_proxy_chain: next };
      });
    });

    document.querySelectorAll<HTMLButtonElement>("[data-chain-down]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-chain-down") || "-1");
        const draft = ensureConfigDraft(state.config, {});
        if (idx < 0 || idx >= draft.upstream_proxy_chain.length - 1) return;
        const next = [...draft.upstream_proxy_chain];
        [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
        configDraft = { ...draft, upstream_proxy_chain: next };
      });
    });

    document.querySelectorAll<HTMLButtonElement>("[data-chain-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-chain-del") || "-1");
        if (idx < 0) return;
        const draft = ensureConfigDraft(state.config, {});
        const next = draft.upstream_proxy_chain.filter((_, i) => i !== idx);
        configDraft = { ...draft, upstream_proxy_chain: next };
      });
    });

    const addBtn = document.getElementById("cfg-chain-add");
    const newInput = document.getElementById("cfg-chain-new") as HTMLInputElement | null;
    addBtn?.addEventListener("click", () => {
      const v = (newInput?.value ?? "").trim();
      if (!v) return;
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, upstream_proxy_chain: [...draft.upstream_proxy_chain, v] };
      if (newInput) newInput.value = "";
    });

    const reloadBtn = document.getElementById("cfg-reload");
    reloadBtn?.addEventListener("click", async () => {
      configError = "";
      configDraft = null;
      setAction("Reloading config...", false);
      await refreshNow(true);
    });

    const saveBtn = document.getElementById("cfg-save");
    saveBtn?.addEventListener("click", async () => {
      await saveConfig(state.config);
    });

    const saveStartBtn = document.getElementById("cfg-save-start");
    saveStartBtn?.addEventListener("click", async () => {
      const ok = await saveConfig(state.config);
      if (ok) {
        setAction("Starting proxy...", false);
        const r = await apiPost("/engine/proxy/start");
        if (!r.ok) setAction(`Proxy start failed: ${r.error}`, true);
        else setAction("Proxy start requested.", false);
        await refreshNow(false);
      }
    });

    const rotToggle = document.getElementById("rot-toggle");
    rotToggle?.addEventListener("click", () => {
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, proxy_rotation_enabled: !draft.proxy_rotation_enabled };
    });
    const rotInterval = document.getElementById("rot-interval") as HTMLInputElement | null;
    rotInterval?.addEventListener("input", () => {
      const raw = Number(rotInterval.value);
      const v = Number.isFinite(raw) ? raw : 900;
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, proxy_rotation_interval_sec: v };
    });
    const rotPool = document.getElementById("rot-pool") as HTMLTextAreaElement | null;
    rotPool?.addEventListener("input", () => {
      const lines = (rotPool.value || "")
        .split(/\r?\n/g)
        .map((x) => x.trim())
        .filter(Boolean);
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, proxy_rotation_pool: lines };
    });

    const rotStart = document.getElementById("rot-start");
    rotStart?.addEventListener("click", async () => {
      setAction("Starting rotation...", false);
      const r = await apiPost("/proxy/rotation/start");
      if (!r.ok) setAction(`Rotation start failed: ${r.error}`, true);
      else setAction("Rotation start requested.", false);
      await refreshNow(false);
    });
    const rotStop = document.getElementById("rot-stop");
    rotStop?.addEventListener("click", async () => {
      setAction("Stopping rotation...", false);
      const r = await apiPost("/proxy/rotation/stop");
      if (!r.ok) setAction(`Rotation stop failed: ${r.error}`, true);
      else setAction("Rotation stop requested.", false);
      await refreshNow(false);
    });
    const rotNow = document.getElementById("rot-now");
    rotNow?.addEventListener("click", async () => {
      setAction("Rotating now...", false);
      const r = await apiPost("/proxy/rotation/rotate");
      if (!r.ok) setAction(`Rotate now failed: ${r.error}`, true);
      else setAction("Rotate now requested.", false);
      await refreshNow(false);
    });

    const foToggle = document.getElementById("fo-toggle");
    foToggle?.addEventListener("click", () => {
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, failover_enabled: !draft.failover_enabled };
    });
    const foInterval = document.getElementById("fo-interval") as HTMLInputElement | null;
    foInterval?.addEventListener("input", () => {
      const raw = Number(foInterval.value);
      const v = Number.isFinite(raw) ? raw : 15;
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, failover_check_interval_sec: v };
    });
    const foProbe = document.getElementById("fo-probe") as HTMLInputElement | null;
    foProbe?.addEventListener("input", () => {
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, failover_probe_host: foProbe.value };
    });
    const foBackups = document.getElementById("fo-backups") as HTMLTextAreaElement | null;
    foBackups?.addEventListener("input", () => {
      const lines = (foBackups.value || "")
        .split(/\r?\n/g)
        .map((x) => x.trim())
        .filter(Boolean);
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, failover_backups: lines };
    });

    const foStart = document.getElementById("fo-start");
    foStart?.addEventListener("click", async () => {
      await saveConfig(state.config);
      setAction("Starting failover monitor...", false);
      const r = await apiPost("/proxy/failover/start");
      if (!r.ok) setAction(`Failover start failed: ${r.error}`, true);
      else setAction("Failover start requested.", false);
      await refreshNow(false);
    });
    const foStop = document.getElementById("fo-stop");
    foStop?.addEventListener("click", async () => {
      setAction("Stopping failover monitor...", false);
      const r = await apiPost("/proxy/failover/stop");
      if (!r.ok) setAction(`Failover stop failed: ${r.error}`, true);
      else setAction("Failover stop requested.", false);
      await refreshNow(false);
    });
    const foTrigger = document.getElementById("fo-trigger");
    foTrigger?.addEventListener("click", async () => {
      await saveConfig(state.config);
      setAction("Triggering failover...", false);
      const r = await apiPost("/proxy/failover/trigger");
      if (!r.ok) setAction(`Failover trigger failed: ${r.error}`, true);
      else setAction("Failover trigger requested.", false);
      await refreshNow(false);
    });

    const fpUa = document.getElementById("fp-ua") as HTMLInputElement | null;
    fpUa?.addEventListener("input", () => {
      configDraft = ensureConfigDraft(state.config, { fingerprint_user_agent: fpUa.value });
    });
    const fpStrip = document.getElementById("fp-strip");
    fpStrip?.addEventListener("click", () => {
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, fingerprint_strip_headers: !draft.fingerprint_strip_headers };
    });
    const fpAl = document.getElementById("fp-al") as HTMLInputElement | null;
    fpAl?.addEventListener("input", () => {
      configDraft = ensureConfigDraft(state.config, { fingerprint_accept_language: fpAl.value });
    });
    const fpCh = document.getElementById("fp-ch");
    fpCh?.addEventListener("click", () => {
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, fingerprint_strip_client_hints: !draft.fingerprint_strip_client_hints };
    });

    const isoAdd = document.getElementById("iso-add");
    const isoEnable = document.getElementById("iso-enable");
    const isoDisable = document.getElementById("iso-disable");
    document.querySelectorAll<HTMLButtonElement>("[data-usepid]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pid = btn.getAttribute("data-usepid") ?? "";
        const pidEl = document.getElementById("iso-pid") as HTMLInputElement | null;
        if (pidEl) pidEl.value = pid;
      });
    });
    isoAdd?.addEventListener("click", async () => {
      const pidEl = document.getElementById("iso-pid") as HTMLInputElement | null;
      const circuitEl = document.getElementById("iso-circuit") as HTMLInputElement | null;
      const proxyEl = document.getElementById("iso-proxyaddr") as HTMLInputElement | null;

      const pid = Number(pidEl?.value ?? "");
      const circuitId = (circuitEl?.value ?? "").trim();
      const proxyAddr = (proxyEl?.value ?? "").trim();
      if (!Number.isFinite(pid) || pid <= 0 || !circuitId || !proxyAddr) return;

      const current = Array.isArray(state.isolationStatus?.rules) ? state.isolationStatus!.rules : [];
      const next = [
        ...current.map((r) => ({ pid: r.pid, circuit_id: r.circuit_id, proxy_addr: r.proxy_addr })),
        { pid, circuit_id: circuitId, proxy_addr: proxyAddr },
      ];

      setAction("Updating isolation rules...", false);
      const r = await apiPost("/engine/isolation/rules", { rules: next });
      if (!r.ok) setAction(`Isolation rules failed: ${r.error}`, true);
      else setAction("Isolation rules updated.", false);
      await refreshNow(false);
    });
    isoEnable?.addEventListener("click", async () => {
      setAction("Enabling isolation...", false);
      const r = await apiPost("/engine/isolation/enable");
      if (!r.ok) setAction(`Isolation enable failed: ${r.error}`, true);
      else setAction("Isolation enable requested.", false);
      await refreshNow(false);
    });
    isoDisable?.addEventListener("click", async () => {
      setAction("Disabling isolation...", false);
      const r = await apiPost("/engine/isolation/disable");
      if (!r.ok) setAction(`Isolation disable failed: ${r.error}`, true);
      else setAction("Isolation disable requested.", false);
      await refreshNow(false);
    });
  }

  if (view === "fingerprint") {
    const adapterSel = document.getElementById("mac-adapter") as HTMLSelectElement | null;
    if (adapterSel && !macSelectedAdapter) {
      macSelectedAdapter = adapterSel.value;
    }
    adapterSel?.addEventListener("change", () => {
      macSelectedAdapter = adapterSel.value;
    });

    const customEl = document.getElementById("mac-custom") as HTMLInputElement | null;
    customEl?.addEventListener("input", () => {
      macCustom = customEl.value;
    });

    const spoofRandom = document.getElementById("mac-random");
    spoofRandom?.addEventListener("click", async () => {
      if (!macSpoofArmed) {
        macSpoofArmed = true;
        macResetArmed = false;
        return;
      }
      macSpoofArmed = false;
      setAction("Spoofing MAC (random)...", false);
      const r = await apiPost("/engine/fingerprint/mac/spoof", { adapter_name: macSelectedAdapter, mode: "random" });
      if (!r.ok) setAction(`MAC spoof failed: ${r.error}`, true);
      else setAction("MAC spoof requested.", false);
      await refreshNow(false);
    });

    const spoofCustom = document.getElementById("mac-custom-btn");
    spoofCustom?.addEventListener("click", async () => {
      if (!macSpoofArmed) {
        macSpoofArmed = true;
        macResetArmed = false;
        return;
      }
      macSpoofArmed = false;
      setAction("Spoofing MAC (custom)...", false);
      const r = await apiPost("/engine/fingerprint/mac/spoof", { adapter_name: macSelectedAdapter, mode: "custom", mac: macCustom });
      if (!r.ok) setAction(`MAC spoof failed: ${r.error}`, true);
      else setAction("MAC spoof requested.", false);
      await refreshNow(false);
    });

    const resetBtn = document.getElementById("mac-reset");
    resetBtn?.addEventListener("click", async () => {
      if (!macResetArmed) {
        macResetArmed = true;
        macSpoofArmed = false;
        jsLeakEnableArmed = false;
        jsLeakDisableArmed = false;
        return;
      }
      macResetArmed = false;
      setAction("Resetting MAC...", false);
      const r = await apiPost("/engine/fingerprint/mac/reset", { adapter_name: macSelectedAdapter });
      if (!r.ok) setAction(`MAC reset failed: ${r.error}`, true);
      else setAction("MAC reset requested.", false);
      await refreshNow(false);
    });

    const jslWebrtc = document.getElementById("jsl-webrtc");
    jslWebrtc?.addEventListener("click", () => {
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, jsleak_block_webrtc: !draft.jsleak_block_webrtc };
    });
    const jslMdns = document.getElementById("jsl-mdns");
    jslMdns?.addEventListener("click", () => {
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, jsleak_block_mdns: !draft.jsleak_block_mdns };
    });
    const jslQuic = document.getElementById("jsl-quic");
    jslQuic?.addEventListener("click", () => {
      const draft = ensureConfigDraft(state.config, {});
      configDraft = { ...draft, jsleak_block_quic: !draft.jsleak_block_quic };
    });

    const jslEnable = document.getElementById("jsl-enable");
    jslEnable?.addEventListener("click", async () => {
      if (!jsLeakEnableArmed) {
        jsLeakEnableArmed = true;
        jsLeakDisableArmed = false;
        macSpoofArmed = false;
        macResetArmed = false;
        return;
      }
      jsLeakEnableArmed = false;
      await saveConfig(state.config);
      setAction("Enabling JS leak protection...", false);
      const r = await apiPost("/engine/fingerprint/jsleak/enable");
      if (!r.ok) setAction(`JS leak enable failed: ${r.error}`, true);
      else setAction("JS leak protection enable requested.", false);
      await refreshNow(false);
    });

    const jslDisable = document.getElementById("jsl-disable");
    jslDisable?.addEventListener("click", async () => {
      if (!jsLeakDisableArmed) {
        jsLeakDisableArmed = true;
        jsLeakEnableArmed = false;
        macSpoofArmed = false;
        macResetArmed = false;
        return;
      }
      jsLeakDisableArmed = false;
      setAction("Disabling JS leak protection...", false);
      const r = await apiPost("/engine/fingerprint/jsleak/disable");
      if (!r.ok) setAction(`JS leak disable failed: ${r.error}`, true);
      else setAction("JS leak protection disable requested.", false);
      await refreshNow(false);
    });
  }
}

function patch(state: HealthState) {
  const statusColor = state.pythonOk && state.engineOk ? "ok" : state.pythonOk ? "warn" : "down";
  const statusDot = document.getElementById("statusdot");
  if (statusDot) statusDot.className = `statusdot statusdot--${statusColor}`;

  const maskedIp = state.maskedIp || "---.---.---.---";
  const ipEl = document.getElementById("masked-ip");
  if (ipEl) ipEl.textContent = `MASKED IP ${maskedIp}`;

  const killswitchLabel = state.killswitchEnabled
    ? "DISABLE KILL SWITCH"
    : killswitchArmed
      ? "CONFIRM KILL SWITCH"
      : "KILL SWITCH";
  const ksBtn = document.getElementById("killswitch-btn");
  if (ksBtn) ksBtn.textContent = killswitchLabel;

  const pyEl = document.getElementById("status-python");
  if (pyEl) pyEl.textContent = state.pythonOk ? "ONLINE" : "OFFLINE";
  const enEl = document.getElementById("status-engine");
  if (enEl) enEl.textContent = state.engineOk ? "ONLINE" : "OFFLINE";
  const prEl = document.getElementById("status-proxy");
  if (prEl) prEl.textContent = state.proxyRunning ? "RUNNING" : "STOPPED";
  const ksEl = document.getElementById("status-ks");
  if (ksEl) ksEl.textContent = state.killswitchEnabled ? "ENABLED" : "DISABLED";

  if (activeView === "dashboard") {
    const tf = trafficFilter.trim().toLowerCase();
    const traffic = tf
      ? trafficHistory.filter((c) => {
          const hay = [
            c.proto,
            c.local,
            c.remote,
            c.remote_ip ?? "",
            c.remote_rdns ?? "",
            c.process_name ?? "",
            c.process_path ?? "",
            c.state ?? "",
            c.pid ? String(c.pid) : "",
          ]
            .join(" ")
            .toLowerCase();
          return hay.includes(tf);
        })
      : trafficHistory;

    const countEl = document.getElementById("conn-count");
    if (countEl) countEl.textContent = String(traffic.length);
    const lastEl = document.getElementById("conn-last");
    if (lastEl) lastEl.textContent = state.monitorTakenAt || "";

    const tbody = document.getElementById("conn-tbody");
    if (tbody) {
      const rows = traffic.slice(0, 220).map((c) => {
        const pid = c.pid ? String(c.pid) : "";
        const st = c.state ? c.state : "";
        const pname = c.process_name ? escapeText(c.process_name) : "";
        const rip = c.remote_ip ? escapeText(c.remote_ip) : "";
        const rdns = c.remote_rdns ? escapeText(c.remote_rdns) : "";
        const rclass = c.remote_class ? escapeText(c.remote_class) : "";
        const rlabel = rdns || rip || escapeText(c.remote);
        return `<tr><td>${escapeText(c.proto)}</td><td class="mono">${escapeText(c.local)}</td><td>${rlabel}<div class="muted mono" style="margin-top: 2px;">${rclass}</div></td><td>${escapeText(st)}</td><td class="mono">${pid}</td><td>${pname}</td></tr>`;
      });
      tbody.innerHTML = rows.join("");
    }
  }
}

async function poll(): Promise<HealthState> {
  const state: HealthState = {
    pythonOk: false,
    engineOk: false,
    proxyRunning: false,
    killswitchEnabled: false,
    dnsServers: [],
    monitorTakenAt: "",
    connections: [],
    maskedIp: "",
    config: null,
    rotationStatus: null,
    isolationStatus: null,
    processes: [],
    macAdapters: [],
    jsLeakStatus: null,
    trackerBlocks: [],
    logs: [],
    dnsInterfaces: [],
    dnsEnforce: null,
    failoverStatus: null,
  };

  try {
    const res = await fetch(`${PYTHON_BASE_URL}/health`, { method: "GET" });
    state.pythonOk = res.ok;
  } catch {
    state.pythonOk = false;
  }

  if (state.pythonOk) {
    try {
      const res = await fetch(`${PYTHON_BASE_URL}/engine/health`, { method: "GET" });
      state.engineOk = res.ok;
    } catch {
      state.engineOk = false;
    }
    try {
      const res = await fetch(`${PYTHON_BASE_URL}/engine/proxy/status`, { method: "GET" });
      const data = (await res.json()) as { running?: boolean };
      state.proxyRunning = Boolean(data?.running);
    } catch {
      state.proxyRunning = false;
    }

    try {
      const res = await fetch(`${PYTHON_BASE_URL}/engine/killswitch/status`, { method: "GET" });
      const data = (await res.json()) as { enabled?: boolean };
      state.killswitchEnabled = Boolean(data?.enabled);
    } catch {
      state.killswitchEnabled = false;
    }

    try {
      const res = await fetch(`${PYTHON_BASE_URL}/engine/dns/status`, { method: "GET" });
      const data = (await res.json()) as { servers?: string[] };
      state.dnsServers = Array.isArray(data?.servers) ? data.servers : [];
    } catch {
      state.dnsServers = [];
    }

    if (activeView === "dns") {
      try {
        const res = await fetch(`${PYTHON_BASE_URL}/engine/dns/interfaces`, { method: "GET" });
        const data = (await res.json()) as { interfaces?: Array<{ name?: string; status?: string }> };
        const items = Array.isArray(data?.interfaces) ? data.interfaces : [];
        state.dnsInterfaces = items
          .filter((it) => typeof it.name === "string")
          .map((it) => ({ name: it.name as string, status: typeof it.status === "string" ? (it.status as string) : "" }));
      } catch {
        state.dnsInterfaces = [];
      }
      try {
        const res = await fetch(`${PYTHON_BASE_URL}/engine/dns/enforce/status`, { method: "GET" });
        const data = (await res.json()) as { enabled?: boolean; supported?: boolean; servers?: string[]; since?: string | null };
        state.dnsEnforce = {
          enabled: Boolean(data?.enabled),
          supported: Boolean(data?.supported),
          servers: Array.isArray(data?.servers) ? data.servers.map((x) => String(x)) : [],
          since: typeof data?.since === "string" ? data.since : null,
        };
      } catch {
        state.dnsEnforce = null;
      }
    }

    try {
      const res = await fetch(`${PYTHON_BASE_URL}/engine/monitor/connections`, { method: "GET" });
      const data = (await res.json()) as { taken_at?: string; connections?: HealthState["connections"] };
      state.monitorTakenAt = typeof data?.taken_at === "string" ? data.taken_at : "";
      state.connections = Array.isArray(data?.connections) ? data.connections : [];
      if (!trafficPaused && state.monitorTakenAt && state.connections.length) {
        const existing = new Set(trafficHistory.map((c) => `${c.proto}|${c.local}|${c.remote}|${c.pid ?? ""}|${c.state ?? ""}`));
        const next: typeof trafficHistory = [];
        for (const c of state.connections) {
          const key = `${c.proto}|${c.local}|${c.remote}|${c.pid ?? ""}|${c.state ?? ""}`;
          if (!existing.has(key)) {
            next.push({ ...c, seen_at: state.monitorTakenAt });
          }
        }
        trafficHistory = [...next, ...trafficHistory].slice(0, 500);
      }
    } catch {
      state.connections = [];
    }

    try {
      const res = await fetch(`${PYTHON_BASE_URL}/config`, { method: "GET" });
      const data = (await res.json()) as Partial<AppConfig>;
      state.config = normalizeConfig(data);
    } catch {
      state.config = null;
    }

    try {
      const res = await fetch(`${PYTHON_BASE_URL}/proxy/rotation/status`, { method: "GET" });
      const data = (await res.json()) as RotationStatus;
      if (data && typeof data === "object") state.rotationStatus = data;
    } catch {
      state.rotationStatus = null;
    }

    try {
      const res = await fetch(`${PYTHON_BASE_URL}/engine/isolation/status`, { method: "GET" });
      const data = (await res.json()) as IsolationStatus;
      if (data && typeof data === "object") state.isolationStatus = data;
    } catch {
      state.isolationStatus = null;
    }

    if (activeView === "proxy") {
      try {
        const res = await fetch(`${PYTHON_BASE_URL}/system/processes`, { method: "GET" });
        const data = (await res.json()) as { processes?: Array<{ pid?: number; name?: string }> };
        const items = Array.isArray(data?.processes) ? data.processes : [];
        state.processes = items
          .filter((p) => typeof p.pid === "number" && typeof p.name === "string")
          .map((p) => ({ pid: p.pid as number, name: p.name as string }));
      } catch {
        state.processes = [];
      }
      try {
        const res = await fetch(`${PYTHON_BASE_URL}/proxy/failover/status`, { method: "GET" });
        const data = (await res.json()) as FailoverStatus;
        if (data && typeof data === "object") state.failoverStatus = data;
      } catch {
        state.failoverStatus = null;
      }
    }

    if (activeView === "fingerprint") {
      try {
        const res = await fetch(`${PYTHON_BASE_URL}/engine/fingerprint/mac/adapters`, { method: "GET" });
        const data = (await res.json()) as { adapters?: MacAdapter[] };
        state.macAdapters = Array.isArray(data?.adapters) ? data.adapters : [];
      } catch {
        state.macAdapters = [];
      }
      try {
        const res = await fetch(`${PYTHON_BASE_URL}/engine/fingerprint/jsleak/status`, { method: "GET" });
        const data = (await res.json()) as JSLeakStatus;
        if (data && typeof data === "object") state.jsLeakStatus = data;
      } catch {
        state.jsLeakStatus = null;
      }
    }

    if (activeView === "tracker") {
      try {
        const res = await fetch(`${PYTHON_BASE_URL}/engine/monitor/blocks`, { method: "GET" });
        const data = (await res.json()) as { blocked_ips?: string[] };
        state.trackerBlocks = Array.isArray(data?.blocked_ips) ? data.blocked_ips.map((x) => String(x)) : [];
      } catch {
        state.trackerBlocks = [];
      }
    }

    if (activeView === "logs") {
      try {
        const res = await fetch(`${PYTHON_BASE_URL}/logs/tail`, { method: "GET" });
        const data = (await res.json()) as { entries?: LogEntry[] };
        state.logs = Array.isArray(data?.entries) ? data.entries : [];
      } catch {
        state.logs = [];
      }
    }
  }

  return state;
}

window.addEventListener("DOMContentLoaded", async () => {
  bootDiagnostics();
  let ksKeyArmedAt = 0;

  window.addEventListener("keydown", async (e) => {
    if (!lastState) return;

    if (e.key === "Escape") {
      killswitchArmed = false;
      macSpoofArmed = false;
      macResetArmed = false;
      jsLeakEnableArmed = false;
      jsLeakDisableArmed = false;
      dnsApplyArmed = false;
      dnsEnforceArmed = false;
      dnsUnenforceArmed = false;
      trackerArmedIp = "";
      trackerArmedAction = "";
      trackerClearArmed = false;
      render(lastState);
      return;
    }

    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (lastState.killswitchEnabled) {
        killswitchArmed = false;
        setAction("Disabling kill switch...", false);
        const r = await apiPost("/engine/killswitch/disable");
        if (!r.ok) setAction(`Kill switch disable failed: ${r.error}`, true);
        else setAction("Kill switch disable requested.", false);
        await refreshNow(false);
        return;
      }
      const now = Date.now();
      if (now - ksKeyArmedAt < 1500) {
        ksKeyArmedAt = 0;
        killswitchArmed = false;
        setAction("Enabling kill switch...", false);
        const r = await apiPost("/engine/killswitch/enable");
        if (!r.ok) setAction(`Kill switch enable failed: ${r.error}`, true);
        else setAction("Kill switch enable requested.", false);
        await refreshNow(false);
        return;
      }
      ksKeyArmedAt = now;
      killswitchArmed = true;
      render(lastState);
      return;
    }

    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      if (lastState.proxyRunning) {
        setAction("Stopping proxy...", false);
        const r = await apiPost("/engine/proxy/stop");
        if (!r.ok) setAction(`Proxy stop failed: ${r.error}`, true);
        else setAction("Proxy stop requested.", false);
        await refreshNow(false);
      } else {
        setAction("Starting proxy...", false);
        const r = await apiPost("/engine/proxy/start");
        if (!r.ok) setAction(`Proxy start failed: ${r.error}`, true);
        else setAction("Proxy start requested.", false);
        await refreshNow(false);
      }
      return;
    }

    if (e.ctrlKey && !e.shiftKey) {
      const key = e.key;
      const map: Record<string, ViewKey> = {
        "1": "dashboard",
        "2": "proxy",
        "3": "dns",
        "4": "fingerprint",
        "5": "tracker",
        "6": "logs",
      };
      const v = map[key];
      if (v) {
        e.preventDefault();
        activeView = v;
        setAction(`View: ${v.toUpperCase()}`, false);
        render(lastState);
      }
    }
  });

  lastState = await poll();
  render(lastState);
  setInterval(async () => {
    lastState = await poll();
    patch(lastState);
  }, 1500);
});

function normalizeConfig(v: Partial<AppConfig> | null | undefined): AppConfig {
  const d = defaultConfig();
  if (!v) return d;
  return {
    engine_base_url: typeof v.engine_base_url === "string" ? v.engine_base_url : d.engine_base_url,
    api_listen_host: typeof v.api_listen_host === "string" ? v.api_listen_host : d.api_listen_host,
    api_listen_port: typeof v.api_listen_port === "number" ? v.api_listen_port : d.api_listen_port,
    proxy_listen_addr: typeof v.proxy_listen_addr === "string" ? v.proxy_listen_addr : d.proxy_listen_addr,
    upstream_proxy_url: typeof v.upstream_proxy_url === "string" ? v.upstream_proxy_url : d.upstream_proxy_url,
    upstream_proxy_chain: Array.isArray(v.upstream_proxy_chain)
      ? v.upstream_proxy_chain.map((x) => String(x))
      : d.upstream_proxy_chain,
    proxy_rotation_enabled:
      typeof v.proxy_rotation_enabled === "boolean" ? v.proxy_rotation_enabled : d.proxy_rotation_enabled,
    proxy_rotation_interval_sec:
      typeof v.proxy_rotation_interval_sec === "number"
        ? v.proxy_rotation_interval_sec
        : d.proxy_rotation_interval_sec,
    proxy_rotation_pool: Array.isArray(v.proxy_rotation_pool)
      ? v.proxy_rotation_pool.map((x) => String(x))
      : d.proxy_rotation_pool,
    proxy_rotation_index: typeof v.proxy_rotation_index === "number" ? v.proxy_rotation_index : d.proxy_rotation_index,
    fingerprint_user_agent:
      typeof v.fingerprint_user_agent === "string" ? v.fingerprint_user_agent : d.fingerprint_user_agent,
    fingerprint_strip_headers:
      typeof v.fingerprint_strip_headers === "boolean"
        ? v.fingerprint_strip_headers
        : d.fingerprint_strip_headers,
    fingerprint_accept_language:
      typeof v.fingerprint_accept_language === "string"
        ? v.fingerprint_accept_language
        : d.fingerprint_accept_language,
    fingerprint_strip_client_hints:
      typeof v.fingerprint_strip_client_hints === "boolean"
        ? v.fingerprint_strip_client_hints
        : d.fingerprint_strip_client_hints,
    jsleak_block_webrtc:
      typeof v.jsleak_block_webrtc === "boolean" ? v.jsleak_block_webrtc : d.jsleak_block_webrtc,
    jsleak_block_mdns: typeof v.jsleak_block_mdns === "boolean" ? v.jsleak_block_mdns : d.jsleak_block_mdns,
    jsleak_block_quic: typeof v.jsleak_block_quic === "boolean" ? v.jsleak_block_quic : d.jsleak_block_quic,
    dns_interface_name: typeof v.dns_interface_name === "string" ? v.dns_interface_name : d.dns_interface_name,
    dns_servers: Array.isArray(v.dns_servers) ? v.dns_servers.map((x) => String(x)) : d.dns_servers,
    dns_enforce: typeof v.dns_enforce === "boolean" ? v.dns_enforce : d.dns_enforce,
    ui_theme:
      v.ui_theme === "contrast" || v.ui_theme === "black" || v.ui_theme === "dark"
        ? v.ui_theme
        : d.ui_theme,
    ui_profile:
      v.ui_profile === "high" || v.ui_profile === "moderate" || v.ui_profile === "light" || v.ui_profile === "custom"
        ? v.ui_profile
        : d.ui_profile,
    failover_enabled: typeof v.failover_enabled === "boolean" ? v.failover_enabled : d.failover_enabled,
    failover_check_interval_sec:
      typeof v.failover_check_interval_sec === "number" ? v.failover_check_interval_sec : d.failover_check_interval_sec,
    failover_probe_host:
      typeof v.failover_probe_host === "string" ? v.failover_probe_host : d.failover_probe_host,
    failover_backups: Array.isArray(v.failover_backups) ? v.failover_backups.map((x) => String(x)) : d.failover_backups,
    failover_index: typeof v.failover_index === "number" ? v.failover_index : d.failover_index,
  };
}

function ensureConfigDraft(config: AppConfig | null, patch: Partial<AppConfig>): AppConfig {
  const base = configDraft ?? config ?? defaultConfig();
  const next = { ...base, ...patch };
  if (!Array.isArray(next.upstream_proxy_chain)) next.upstream_proxy_chain = [];
  if (!Array.isArray(next.proxy_rotation_pool)) next.proxy_rotation_pool = [];
  if (!Array.isArray(next.dns_servers)) next.dns_servers = [];
  if (!Array.isArray(next.failover_backups)) next.failover_backups = [];
  return next;
}

async function saveConfig(config: AppConfig | null): Promise<boolean> {
  configError = "";
  configSaving = true;

  const cfg = normalizeConfig(configDraft ?? config ?? defaultConfig());
  const payload: AppConfig = {
    ...cfg,
    upstream_proxy_chain: cfg.upstream_proxy_chain.map((x) => x.trim()).filter(Boolean),
    upstream_proxy_url: cfg.upstream_proxy_url.trim(),
    proxy_listen_addr: cfg.proxy_listen_addr.trim(),
    proxy_rotation_pool: cfg.proxy_rotation_pool.map((x) => x.trim()).filter(Boolean),
    fingerprint_user_agent: cfg.fingerprint_user_agent.trim(),
    fingerprint_accept_language: cfg.fingerprint_accept_language.trim(),
    dns_interface_name: cfg.dns_interface_name.trim(),
    dns_servers: cfg.dns_servers.map((x) => x.trim()).filter(Boolean),
    ui_theme: cfg.ui_theme,
    ui_profile: cfg.ui_profile,
    failover_enabled: cfg.failover_enabled,
    failover_check_interval_sec: cfg.failover_check_interval_sec,
    failover_probe_host: cfg.failover_probe_host.trim(),
    failover_backups: cfg.failover_backups.map((x) => x.trim()).filter(Boolean),
    failover_index: cfg.failover_index,
  };

  try {
    setAction("Saving config...", false);
    const r = await apiJson<Record<string, unknown>>("/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      configError = `CONFIG SAVE FAILED: ${r.error}`;
      setAction(configError, true);
      configSaving = false;
      return false;
    }
    configDraft = null;
    configSaving = false;
    setAction("Config saved.", false);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    configError = `CONFIG SAVE FAILED: ${msg}`;
    setAction(configError, true);
    configSaving = false;
    return false;
  }
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
