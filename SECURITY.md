# Security Policy

## Supported versions

Mo is **alpha** software. Only the latest commit on `main` receives security
fixes. There are no maintained release branches yet.

| Version | Supported |
|---------|-----------|
| `main` (latest) | ✅ |
| Older tags / releases | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's coordinated disclosure flow:

1. Go to the [Security tab](https://github.com/dctongsheng/mo-agent/security/advisories/new)
   of this repository.
2. Click **Report a vulnerability** and describe the issue.

If you cannot use GitHub Security Advisories, open a regular issue containing
only *"security report, please provide a private contact"* — with no technical
detail — and a maintainer will follow up.

What to expect:

- **Acknowledgement** within 5 business days.
- **Initial assessment** (severity, affected surface) within 10 business days.
- **Fix or mitigation plan** communicated before any public disclosure.

We will credit reporters in the advisory unless you ask us not to.

## Scope

Mo runs a local agent that executes tools, spawns subprocesses, and talks to
model providers you configure. The following are **in scope**:

- Sandbox or privilege escapes from the renderer into the Electron main process.
- Authentication bypass on the local gateway (`server/mo-gateway.py`) — for
  example, reaching `/api/mo/*` without the per-boot bearer token.
- Remote code execution triggered by untrusted model output or by a document
  the agent reads.
- Cross-site scripting in the chat renderer (agent replies are markdown, passed
  through DOMPurify in `app/src/renderer/ui/components/Markdown.tsx`).
- Leakage of API keys or `~/.hermes-mo/` contents to a third party.
- Vulnerabilities in the vendored Hermes core that Mo's configuration makes
  exploitable. (Core-only issues should also be reported upstream to
  [Hermes Agent](https://github.com/NousResearch/hermes-agent).)

The following are **out of scope**:

- The agent executing commands you explicitly asked it to execute. Mo is a
  tool-using agent by design; running your instructions is the feature.
- Vulnerabilities in model providers, Ollama, or OpenViking themselves.
- Self-inflicted misconfiguration, e.g. binding the gateway to a public
  interface or committing your own `.env`.
- Missing hardening that has no demonstrated exploit path.

## Design notes relevant to security

- The gateway binds to `127.0.0.1` only and requires a bearer token that is
  regenerated on every boot.
- The Electron renderer runs with `contextIsolation: true` and
  `nodeIntegration: false`; the preload exposes a fixed, minimal IPC surface.
- Self-evolution rewrites skill files on disk. Candidates must pass the
  constraints in `server/vendor/evolution/core/constraints.py` before they are
  deployed. **A malicious or prompt-injected model can still influence skill
  text** — treat evolved skills as untrusted content and review
  `~/.hermes-mo/` skill diffs if you connect Mo to untrusted data sources.
