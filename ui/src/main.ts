type HealthState = {
  pythonOk: boolean;
  engineOk: boolean;
  proxyRunning: boolean;
  killswitchEnabled: boolean;
  dnsServers: string[];
  connections: Array<{ proto: string; local: string; remote: string; state?: string; pid?: number }>;
  maskedIp: string;
  config: AppConfig | null;
  rotationStatus: RotationStatus | null;
  isolationStatus: IsolationStatus | null;
  processes: Array<{ pid: number; name: string }>;
  macAdapters: MacAdapter[];
  jsLeakStatus: JSLeakStatus | null;
};

const PYTHON_BASE_URL = "http://127.0.0.1:51338";
let killswitchArmed = false;
let activeView: ViewKey = "dashboard";
let configDraft: AppConfig | null = null;
let configSaving = false;
let configError = "";
let macSpoofArmed = false;
let macResetArmed = false;
let macSelectedAdapter = "";
let macCustom = "";
let jsLeakEnableArmed = false;
let jsLeakDisableArmed = false;

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
  const connectionCount = state.connections.length;
  const connectionRows = state.connections.slice(0, 8).map((c) => {
    const pid = c.pid ? String(c.pid) : "";
    const st = c.state ? c.state : "";
    return `<tr><td>${c.proto}</td><td>${c.local}</td><td>${c.remote}</td><td>${st}</td><td>${pid}</td></tr>`;
  });

  const view = activeView;
  const config = configDraft ?? state.config ?? null;
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
  const configPanel =
    view === "proxy"
      ? `
        <section class="panel">
          <div class="panel__title">PROXY CONFIG</div>
          <div class="panel__body">
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
          <div class="panel__title">DNS STATUS</div>
          <div class="panel__body">
            <div class="kv">
              <div class="kv__k">SERVERS</div>
              <div class="kv__v mono">${dnsServers}</div>
            </div>
            <div class="actions">
              <button class="btn" type="button" id="dns-refresh">REFRESH</button>
              <button class="btn" type="button" id="dns-flush">FLUSH CACHE</button>
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
            <div class="kv">
              <div class="kv__k">COUNT</div>
              <div class="kv__v">${connectionCount}</div>
            </div>
            <div class="tablewrap">
              <table class="table">
                <thead>
                  <tr><th>PROTO</th><th>LOCAL</th><th>REMOTE</th><th>STATE</th><th>PID</th></tr>
                </thead>
                <tbody>
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
          <div class="status">
            <span class="statusdot statusdot--${statusColor}"></span>
            <span class="status__ip">MASKED IP ${maskedIp}</span>
          </div>
          <button class="killswitch" type="button" id="killswitch-btn">${killswitchLabel}</button>
        </div>
      </header>

      <main class="workspace">
        <section class="panel ${view !== "dashboard" ? "is-hidden" : ""}">
          <div class="panel__title">SYSTEM STATUS</div>
          <div class="panel__body">
            <div class="kv">
              <div class="kv__k">PYTHON API</div>
              <div class="kv__v">${state.pythonOk ? "ONLINE" : "OFFLINE"}</div>
            </div>
            <div class="kv">
              <div class="kv__k">GO ENGINE</div>
              <div class="kv__v">${state.engineOk ? "ONLINE" : "OFFLINE"}</div>
            </div>
            <div class="kv">
              <div class="kv__k">PROXY</div>
              <div class="kv__v">${state.proxyRunning ? "RUNNING" : "STOPPED"}</div>
            </div>
            <div class="kv">
              <div class="kv__k">KILL SWITCH</div>
              <div class="kv__v">${state.killswitchEnabled ? "ENABLED" : "DISABLED"}</div>
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
        ${configPanel}
      </main>
    </div>
  `;

  document.querySelectorAll<HTMLButtonElement>("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-nav") as ViewKey | null;
      if (!next) return;
      activeView = next;
      render(state);
    });
  });

  const startBtn = document.getElementById("proxy-start");
  const stopBtn = document.getElementById("proxy-stop");
  startBtn?.addEventListener("click", async () => {
    await fetch(`${PYTHON_BASE_URL}/engine/proxy/start`, { method: "POST" }).catch(() => {});
  });
  stopBtn?.addEventListener("click", async () => {
    await fetch(`${PYTHON_BASE_URL}/engine/proxy/stop`, { method: "POST" }).catch(() => {});
  });

  const dnsRefresh = document.getElementById("dns-refresh");
  const dnsFlush = document.getElementById("dns-flush");
  dnsRefresh?.addEventListener("click", async () => {
    await fetch(`${PYTHON_BASE_URL}/engine/dns/status`, { method: "GET" }).catch(() => {});
  });
  dnsFlush?.addEventListener("click", async () => {
    await fetch(`${PYTHON_BASE_URL}/engine/dns/flush`, { method: "POST" }).catch(() => {});
  });

  const ksBtn = document.getElementById("killswitch-btn");
  ksBtn?.addEventListener("click", async () => {
    if (state.killswitchEnabled) {
      killswitchArmed = false;
      await fetch(`${PYTHON_BASE_URL}/engine/killswitch/disable`, { method: "POST" }).catch(() => {});
      return;
    }

    if (!killswitchArmed) {
      killswitchArmed = true;
      return;
    }

    killswitchArmed = false;
    await fetch(`${PYTHON_BASE_URL}/engine/killswitch/enable`, { method: "POST" }).catch(() => {});
  });

  if (view === "proxy") {
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
      await fetch(`${PYTHON_BASE_URL}/config`, { method: "GET" }).catch(() => {});
    });

    const saveBtn = document.getElementById("cfg-save");
    saveBtn?.addEventListener("click", async () => {
      await saveConfig(state.config);
    });

    const saveStartBtn = document.getElementById("cfg-save-start");
    saveStartBtn?.addEventListener("click", async () => {
      const ok = await saveConfig(state.config);
      if (ok) {
        await fetch(`${PYTHON_BASE_URL}/engine/proxy/start`, { method: "POST" }).catch(() => {});
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
      await fetch(`${PYTHON_BASE_URL}/proxy/rotation/start`, { method: "POST" }).catch(() => {});
    });
    const rotStop = document.getElementById("rot-stop");
    rotStop?.addEventListener("click", async () => {
      await fetch(`${PYTHON_BASE_URL}/proxy/rotation/stop`, { method: "POST" }).catch(() => {});
    });
    const rotNow = document.getElementById("rot-now");
    rotNow?.addEventListener("click", async () => {
      await fetch(`${PYTHON_BASE_URL}/proxy/rotation/rotate`, { method: "POST" }).catch(() => {});
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

      await fetch(`${PYTHON_BASE_URL}/engine/isolation/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: next }),
      }).catch(() => {});
    });
    isoEnable?.addEventListener("click", async () => {
      await fetch(`${PYTHON_BASE_URL}/engine/isolation/enable`, { method: "POST" }).catch(() => {});
    });
    isoDisable?.addEventListener("click", async () => {
      await fetch(`${PYTHON_BASE_URL}/engine/isolation/disable`, { method: "POST" }).catch(() => {});
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
      await fetch(`${PYTHON_BASE_URL}/engine/fingerprint/mac/spoof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adapter_name: macSelectedAdapter, mode: "random" }),
      }).catch(() => {});
    });

    const spoofCustom = document.getElementById("mac-custom-btn");
    spoofCustom?.addEventListener("click", async () => {
      if (!macSpoofArmed) {
        macSpoofArmed = true;
        macResetArmed = false;
        return;
      }
      macSpoofArmed = false;
      await fetch(`${PYTHON_BASE_URL}/engine/fingerprint/mac/spoof`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adapter_name: macSelectedAdapter, mode: "custom", mac: macCustom }),
      }).catch(() => {});
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
      await fetch(`${PYTHON_BASE_URL}/engine/fingerprint/mac/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adapter_name: macSelectedAdapter }),
      }).catch(() => {});
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
      await fetch(`${PYTHON_BASE_URL}/engine/fingerprint/jsleak/enable`, { method: "POST" }).catch(() => {});
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
      await fetch(`${PYTHON_BASE_URL}/engine/fingerprint/jsleak/disable`, { method: "POST" }).catch(() => {});
    });
  }
}

async function poll(): Promise<HealthState> {
  const state: HealthState = {
    pythonOk: false,
    engineOk: false,
    proxyRunning: false,
    killswitchEnabled: false,
    dnsServers: [],
    connections: [],
    maskedIp: "",
    config: null,
    rotationStatus: null,
    isolationStatus: null,
    processes: [],
    macAdapters: [],
    jsLeakStatus: null,
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

    try {
      const res = await fetch(`${PYTHON_BASE_URL}/engine/monitor/connections`, { method: "GET" });
      const data = (await res.json()) as { connections?: HealthState["connections"] };
      state.connections = Array.isArray(data?.connections) ? data.connections : [];
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
  }

  return state;
}

window.addEventListener("DOMContentLoaded", async () => {
  render(await poll());
  setInterval(async () => {
    render(await poll());
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
  };
}

function ensureConfigDraft(config: AppConfig | null, patch: Partial<AppConfig>): AppConfig {
  const base = configDraft ?? config ?? defaultConfig();
  const next = { ...base, ...patch };
  if (!Array.isArray(next.upstream_proxy_chain)) next.upstream_proxy_chain = [];
  if (!Array.isArray(next.proxy_rotation_pool)) next.proxy_rotation_pool = [];
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
  };

  try {
    const res = await fetch(`${PYTHON_BASE_URL}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      configError = "CONFIG SAVE FAILED";
      configSaving = false;
      return false;
    }
    configDraft = null;
    configSaving = false;
    return true;
  } catch {
    configError = "CONFIG SAVE FAILED";
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
