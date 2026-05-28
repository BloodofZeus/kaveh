# Kaveh

> *Named after the legendary Persian hero who rose against tyranny and fought for freedom.*

Kaveh is a comprehensive desktop privacy and anonymity tool for Windows, built for journalists, activists, and privacy-conscious users who need serious, granular control over their online presence. It gives you full visibility into your network traffic and the power to shape, control, and protect every aspect of your digital identity.

---

## Why Kaveh?

Most privacy tools either do too little — showing you what's happening without letting you act — or they operate as a black box you can't understand or trust. Kaveh is different. It puts you in full control. You see everything. You decide everything. And when you're done, it cleans up after itself completely.

---

## Tech Stack

| Layer | Technology | Role |
|---|---|---|
| Networking Engine | Go | Proxy routing, traffic monitoring, DNS, kill switch |
| System Logic | Python | Configuration, profiles, logging, failover, API |
| GUI Frontend | Tauri | Dynamic, modern desktop interface |
| Platform | Windows | Primary target platform |

---

## Running on Windows (Development)

Kaveh runs as three local services:

- Go engine API: `http://127.0.0.1:51337`
- Python core API: `http://127.0.0.1:51338`
- Local proxy listener (default): `127.0.0.1:18080`

Some features require Administrator privileges (Windows Firewall rule changes, DNS enforcement, MAC spoof/reset, JS leak protection).

### Prerequisites

- Windows 10/11
- Go installed (engine)
- Python installed (core)
- Node.js + npm installed (ui)
- Rust toolchain + Tauri prerequisites installed (ui)
  - Visual Studio Build Tools (C++ workload; provides `link.exe`)
  - Rust MSVC target (`stable-x86_64-pc-windows-msvc`)

If PowerShell blocks `npm.ps1` on your machine, use `npm.cmd` (examples below).

### Run (3 terminals)

From the repository root:

**Terminal 1 — Go engine**

```powershell
cd C:\Users\c4\Documents\Project\kaveh\engine
go run .
```

**Terminal 2 — Python core API**

```powershell
cd C:\Users\c4\Documents\Project\kaveh
python -m core.api.server
```

**Terminal 3 — Tauri UI**

```powershell
cd C:\Users\c4\Documents\Project\kaveh\ui
npm.cmd install
npm.cmd run tauri -- dev
```

### Quick sanity checks

- Engine health: `GET http://127.0.0.1:51337/health`
- Core health: `GET http://127.0.0.1:51338/health`
- Config file: `config\kaveh.json`
- Audit log file (dev): `logs\kaveh_audit.jsonl` (desktop build uses `%KAVEH_DATA_DIR%\logs\kaveh_audit.jsonl`)

### Build a Windows .exe/.msi locally (Desktop)

This produces a real desktop installer/bundle (not a browser build).

1) Ensure Rust is using the MSVC toolchain:

```powershell
rustup default stable-x86_64-pc-windows-msvc
```

2) Build bundled backend sidecars (engine + core):

```powershell
cd C:\Users\c4\Documents\Project\kaveh
powershell -NoProfile -ExecutionPolicy Bypass -File config\build_sidecars.ps1
```

3) Build the Tauri installer/bundle:

```powershell
cd C:\Users\c4\Documents\Project\kaveh\ui
npm.cmd install
npm.cmd run tauri -- build
```

Outputs:

- App exe: `ui\src-tauri\target\release\ui.exe`
- Installers + updater artifacts: `ui\src-tauri\target\release\bundle\`

---

## Production Release (Windows)

Kaveh’s production Windows build is shipped as a Tauri installer with:

- A signed installer (optional but recommended).
- A signed auto-updater feed.
- Bundled backend sidecars (`kaveh-engine` and `kaveh-core`) started automatically by the desktop app.

### One-time setup

1) **Generate updater signing keys** (keep the private key secret; the public key is embedded in the app). Tauri updater requires signed updates. See: https://tauri.app/plugin/updater/

```powershell
cd C:\Users\c4\Documents\Project\kaveh\ui
npm.cmd run tauri -- signer generate -- -w $HOME\.tauri\kaveh-updater.key
```

2) **Configure GitHub Actions secrets** (repo settings → Actions secrets):

- `TAURI_SIGNING_PRIVATE_KEY` (contents of your updater private key file)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (if you set one)
- `KAVEH_UPDATER_PUBKEY` (the public key text)

Optional Windows code signing (choose one approach):

- Thumbprint signing:
  - `KAVEH_WINDOWS_CERT_THUMBPRINT`
  - `KAVEH_WINDOWS_TIMESTAMP_URL` (optional)
- PFX signing:
  - `KAVEH_WINDOWS_PFX_BASE64` (base64-encoded `.pfx`)
  - `KAVEH_WINDOWS_PFX_PASSWORD`
  - `KAVEH_WINDOWS_TIMESTAMP_URL` (optional)

### Release workflow

Pushing a tag `v*` triggers the release workflow which runs tests, builds sidecars, builds the Tauri installers, signs the update artifacts, generates `latest.json`, and publishes a GitHub Release.

- Workflow: [.github/workflows/release.yml](file:///c:/Users/c4/Documents/Project/kaveh/.github/workflows/release.yml)

### Where production data lives

In production, config and logs are stored in the app data directory (the desktop app sets `KAVEH_DATA_DIR` for sidecars):

- Config: `%KAVEH_DATA_DIR%\config\kaveh.json`
- Logs: `%KAVEH_DATA_DIR%\logs\kaveh_audit.jsonl`

### Production readiness checklist

Kaveh is considered production-ready only when:

- The GitHub Release workflow succeeds for a tagged version and publishes signed installers and a valid `latest.json`.
- A clean Windows VM validation passes:
  - install/uninstall works
  - app starts backend sidecars correctly
  - killswitch enable/disable works with real firewall rules (admin)
  - “proxy drop” scenario triggers kill switch and does not leak traffic
  - reboot with killswitch previously enabled leaves system in a safe/expected state
  - failover trigger works and switches upstream without leaving the proxy stopped

---

## Architecture

```
[ Tauri GUI Frontend ]
        ↕
[ Python — System Logic Layer ]
        ↕
[ Go — Networking Engine ]
```

The three layers communicate through clean, well-defined APIs. Each layer is independent — you can update one without breaking the others. Go runs silently in the background handling all real-time networking. Python coordinates logic and configuration. Tauri presents everything to the user in a live, responsive interface.

**Example Flow:**
```
User clicks "Start Proxy" in Tauri
        ↓
Python receives the command
        ↓
Python instructs the Go engine to start routing
        ↓
Go begins intercepting and routing traffic
        ↓
Go sends live data back to Python
        ↓
Python passes data up to Tauri
        ↓
User sees live traffic in real time
```

---

## Core Features

### 1. Proxy Management with IP Rotation
Configure and manage proxies with complete granular control. Force individual applications through specific proxies, or route all system traffic through a single proxy. Supports proxy chaining. Users choose whether to rotate IPs regularly or stay with one proxy depending on their threat model.

### 2. Live Traffic Monitoring with Fingerprinting
Real-time visibility into all network activity. See the source and destination of every connection, including device fingerprinting for both sides and location awareness. Not just passive monitoring — you can actively block or allow connections as they happen.

### 3. DNS Leak Detection and Active Management
Continuously monitor for DNS leaks. When a leak is detected, Kaveh doesn't just alert you — it gives you the tools to fix it. Switch DNS providers, enforce secure DNS, or block leaking queries directly from the interface.

### 4. Fingerprint Awareness and Spoofing
See exactly what fingerprint signals your machine is broadcasting to the outside world — browser user agent, network agent, device agent. Then actively change them. Full MAC address spoofing and cover identity management so you control what the world sees.

### 5. Web Tracking Visibility and Management
See every tracker attempting to connect to your machine in real time. Block them, monitor them, and understand exactly what is trying to follow you online.

### 6. JavaScript Leak Protection
JavaScript can bypass proxies and expose your real IP address — a critical attack vector that many tools ignore. Kaveh protects against this at the network level so your anonymity holds even against JavaScript-based exploits.

### 7. Circuit Isolation Between Applications
Different applications get isolated network circuits so they cannot be fingerprinted or correlated across sessions. If one application is compromised, it does not expose your entire anonymity profile.

### 8. Kill Switch and Clean Exit
If the proxy drops or you choose to disconnect, Kaveh triggers automatically:
- Blocks all traffic immediately to prevent leaks
- Flushes the network state completely
- Resets MAC addresses to original or chosen state
- Clears DNS cache
- Removes all firewall rules added during the session

No leftover traces. No broken network state. A clean exit every time.

### 9. Logging and Audit Trail
A full session history showing when the kill switch triggered, when IPs rotated, proxy changes, and what happened throughout your session — for accountability, debugging, and peace of mind.

### 10. Configuration Profiles and Presets
Different threat models need different setups. Kaveh comes with prebuilt profiles:
- **High Risk** — aggressive settings for hostile environments
- **Moderate** — balanced protection for general privacy needs
- **Light** — basic protection for everyday use

Users can also create and save their own custom profiles.

### 11. Connectivity and Failover
If your primary proxy goes down mid-session, Kaveh automatically falls back to a configured backup proxy and notifies you. No dropped anonymity, no broken sessions.

### 12. User Onboarding and Setup Wizard
A guided setup wizard helps new users configure their proxies, choose their threat level, understand their options, and get up and running quickly — without needing to understand every technical detail from day one.

---

## Project Structure

```
kaveh/
│
├── engine/               # Go — Networking Engine
│   ├── proxy/            # Proxy routing and chaining
│   ├── dns/              # DNS management and leak prevention
│   ├── monitor/          # Live traffic monitoring
│   ├── isolation/        # Circuit isolation per application
│   ├── killswitch/       # Kill switch and clean exit logic
│   └── fingerprint/      # Network-level fingerprint protection
│
├── core/                 # Python — System Logic Layer
│   ├── config/           # Configuration management
│   ├── profiles/         # Threat level profiles and presets
│   ├── logger/           # Audit trail and session logging
│   ├── failover/         # Proxy failover and backup logic
│   └── api/              # Internal API connecting Python to Go and Tauri
│
├── ui/                   # Tauri — Frontend
│   ├── src/
│   │   ├── dashboard/    # Main live dashboard
│   │   ├── proxy/        # Proxy configuration panel
│   │   ├── dns/          # DNS status and management
│   │   ├── fingerprint/  # Fingerprint viewer and spoofer
│   │   ├── tracker/      # Web tracking visibility
│   │   ├── logs/         # Audit trail viewer
│   │   └── onboarding/   # Setup wizard
│   └── public/
│
├── config/               # Shared configuration files
├── logs/                 # Session logs and audit trail
└── README.md
```

---

## Design Philosophy

Kaveh is not a dumbed-down tool. It respects the intelligence of its users. Journalists and activists operating in hostile environments need to understand exactly what is happening with their traffic — not just trust a green lock icon. Kaveh gives you full visibility, full control, and full accountability over your digital presence.

You decide your threat model. You decide how aggressive your settings are. Kaveh gives you the tools and the information to make those decisions with confidence.

---

## Target Users

- Journalists working in sensitive or hostile environments
- Activists who need to protect their identity and communications
- Privacy-conscious users who want full control over their online presence
- Security researchers and professionals

---

## Platform

- **Primary:** Windows
- Linux and macOS support planned for future releases

---

*Kaveh — like the hero who forged his own shield and led the fight for freedom.*
