# Architecture

Mo is three layers: a desktop app, a thin Python gateway, and the vendored Hermes Agent core.

```
mo-agent/
├── app/                     # Electron desktop app (React 19 + Vite + TypeScript)
│   └── src/
│       ├── main/            # Electron main process: window, python-bridge
│       └── renderer/        # React UI (chat, atelier, settings, self-evolution)
├── server/                  # Python gateway (your code)
│   ├── mo-gateway.py        # entry point: boots Hermes gateway + mounts /api/mo/*
│   └── vendor/
│       └── evolution/       # GEPA self-evolution engine (Nous Research, MIT)
└── vendor/hermes-agent/     # vendored Hermes Agent core (Nous Research, MIT)
```

## Process model

When the app starts, the Electron main process (`app/src/main/python-bridge.ts`) spawns a single Python child process running `server/mo-gateway.py`. That process:

1. Discovers two free localhost ports — one for the Hermes **API server**, one for the **dashboard / web server** (which also hosts Mo's API routes).
2. Prints them to stdout (`HERMES_PORT:` / `HERMES_DASHBOARD_PORT:`) so the main process can wire the renderer to them.
3. Starts the Hermes gateway (`gateway.run.start_gateway`) and the FastAPI web server (`hermes_cli.web_server`), and mounts Mo's `/api/mo/*` router onto the latter via `_mount_mo_routes(app)`.

The renderer talks to the gateway over `http://127.0.0.1:<port>` using a per-boot bearer token (`HERMES_DASHBOARD_SESSION_TOKEN`), never over the network.

## The gateway extension (`server/mo-gateway.py`)

`_mount_mo_routes(app)` adds Mo-specific endpoints that the Hermes core doesn't provide, backed by simple JSON files under `~/.hermes-mo/mo-config/` so they survive restarts:

| Area | Routes |
|------|--------|
| Self-evolution | `/api/mo/evolve/{run,runs,status,skills,schedule}` and `runs/{id}/{accept,reject,log}` |
| Endpoint library | `/api/mo/endpoints…` — register a provider once, reuse across scenarios |
| Model config | `/api/mo/models/{embedding,evolve}` — pick models per scenario |
| Fine-tuning | `/api/mo/finetune/{config,gen-dataset,status}` — scaffold only; the cloud-training scripts are not bundled |
| Local models | `/api/mo/local/*` — Ollama integration |

It also installs a small runtime patch that skips semantic memory recall for very short messages (a bare "hi" gains nothing from a vector search), tunable via `MO_RECALL_MIN_CHARS`.

## Runtime data (`~/.hermes-mo/`)

The app uses a dedicated Hermes home so it never collides with a system-wide Hermes install:

```
~/.hermes-mo/
├── config.yaml          # model provider, memory backend, etc.
├── .env                 # API keys
├── mo-config/           # endpoint library, evolve/finetune selections
├── sessions/            # conversation sessions
├── memory/              # local memory state
├── trajectories/        # recorded work, used to build eval/fine-tune data
└── profiles/            # the dedicated "evolver" profile + its run logs
```

## Memory

Long-term memory is provided by a pluggable Hermes memory backend. The reference setup uses **OpenViking** (a local context database) for semantic recall and resource storage, configured via `~/.openviking/ov.conf`. Recall is prefetched in the background so it rarely blocks a turn, and is skipped entirely for trivial messages.
