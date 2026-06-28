# Production Infrastructure

The 8 containers that run FOTECH. Compact view of what's in production today.

## The eight containers

```
                        ┌──────────────────────┐
                        │     fotech-nginx     │  TLS termination, routing
                        └──────────┬───────────┘
                                   │
            ┌──────────────────────┼──────────────────────────┐
            ▼                      ▼                          ▼
   ┌──────────────────┐  ┌──────────────────┐   ┌─────────────────────┐
   │     starlight    │  │   fotech-odoo    │   │  fotech-voice-agent │
   │  (AI orchestrator│  │  (ERP backend)   │   │  (real-time voice)  │
   │   Node.js)       │  │   Odoo 17        │   │   Pipecat + Sonnet  │
   └────┬─────────────┘  └────────┬─────────┘   └──────────┬──────────┘
        │                         │                        │
        │           ┌─────────────┴────────────────┐       │
        ▼           ▼                              ▼       ▼
   ┌──────────────────────────┐         ┌───────────────────────────┐
   │      fotech-pdp          │         │       fotech-db           │
   │  (Policy Decision Point) │ ────►   │     PostgreSQL 16        │
   │  FastAPI + Python        │         │  pgvector + ltree         │
   └──────────┬───────────────┘         │  + tsvector (Spanish)     │
              │                         └───────────────────────────┘
              ▼
   ┌──────────────────────────┐
   │    fotech-redis-pdp      │
   │   (L1 cache for PDP)     │
   └──────────────────────────┘

   ┌──────────────────────────┐
   │     fotech-keycloak      │  IAM, SSO, 2FA, OAuth 2.0
   │     Keycloak 25          │
   └──────────────────────────┘
```

## What each one does

| Container | Image base | Role | Status |
|---|---|---|---|
| `fotech-nginx` | nginx | TLS termination, reverse proxy, rate limiting | Stable |
| `starlight` | Node.js 20 | AI orchestrator — runs the 8 specialized agents + router | Stable |
| `fotech-odoo` | Odoo 17 | ERP backend (products, inventory, accounting, etc.) | Stable |
| `fotech-db` | PostgreSQL 16 | All persistent data + the AI memory, aliases, cache, audit tables | Stable, healthy |
| `fotech-pdp` | Python 3.12 + FastAPI | Policy Decision Point for RBAC/ABAC/ReBAC decisions | Stable, healthy |
| `fotech-redis-pdp` | Redis 7 | L1 cache for PDP decisions | Stable, healthy |
| `fotech-keycloak` | Keycloak 25 | Identity provider — SSO, 2FA, OAuth 2.0, OIDC for clients | Stable |
| `fotech-voice-agent` | Python 3.12 + Pipecat | Real-time voice agent (Spanish, Mexican accent via ElevenLabs) | Stable, healthy |

Containers are deployed via `docker compose` with explicit version pinning. None of them use `:latest` — every restart is reproducible against the same image SHA.

## The voice agent

This is the one that gets the most reactions because it works in real time. The stack:

- **STT**: Deepgram Nova-3 Flux (streaming Spanish)
- **LLM**: Claude Sonnet 4.6 (the same orchestrator family as the chat agents)
- **TTS**: ElevenLabs Flash v2.5 (Spanish, voice "Valentina")
- **Framework**: Pipecat (open source, BSD-licensed)

Latency budget for one conversational turn:

| Stage | Budget | Typical |
|---|---|---|
| STT (streaming, finalized) | < 500ms | 250–400ms |
| LLM (first token) | < 700ms | 350–550ms |
| TTS (first audio) | < 400ms | 200–350ms |
| **Total to first audible response** | **< 1.6s** | **~1.0–1.3s** |

That's roughly conversational. Faster than a slow human, slower than a fast one. Good enough that pharmacists who tested it kept forgetting they were talking to a machine.

## Why this stack

A short defense of each non-obvious choice:

**Why Keycloak**: Industry standard, mature OAuth 2.0/OIDC, plays well with custom RBAC. Not the easiest to operate but the bug surface is well-understood.

**Why a dedicated PDP container**: Authorization is too important to be a library inside the orchestrator. Separating it means:
- Different scaling characteristics from the orchestrator
- Audit log lives independently of app crashes
- Can be replaced without touching application code (e.g., upgrade from custom PDP to OPA in the future)

**Why Redis just for the PDP**: The PDP is the latency-critical path. Authorization happens on every sensitive action. Going through a network hop to PostgreSQL on every call adds up. Redis as an L1 cache shaves the 95th percentile dramatically.

**Why PostgreSQL for everything else**: One database is easier to operate than five. The combination of `pgvector` (embeddings, future use), `ltree` (org hierarchy), `tsvector` (Spanish full-text), and JSONB (ABAC policies) covers almost every storage need for this platform.

**Why Pipecat for voice**: Open source, framework-agnostic, lets me swap STT/LLM/TTS providers without rewriting. The alternative was a closed-source voice platform.

## Operational reality

Honest notes:

- **Keycloak occasionally reports unhealthy** because its readiness probe is stricter than its actual availability. It serves requests fine through the period. Looking into a less aggressive probe.
- **fotech-odoo is the slowest to restart** (~90 seconds cold). When iterating on Odoo extensions, this is the dev-cycle bottleneck. Solved partially by hot module reload in development.
- **The voice agent is single-tenant per container** today. Multi-tenant requires either per-tenant container instances or session-level tenant isolation in Pipecat. Currently good enough for pilot; will revisit at scale.
- **Backups**: nightly `pg_dump` of `fotech-db` to Backblaze B2 with 30-day retention. Voice-agent recordings are not retained (privacy).
- **Monitoring**: container health is via `docker compose` HEALTHCHECK. No Prometheus/Grafana yet — adding it is on the roadmap once the client count justifies the operational complexity.

## Where the AI lives in this picture

| AI component | Container |
|---|---|
| The 8 chat agents (router, search, sale, etc.) | `starlight` |
| The 4 Haiku tactical sub-agents | `starlight` (same process) |
| The matcher (literal + LLM judge) | `starlight` |
| The voice agent | `fotech-voice-agent` |
| The memory tables and indices | `fotech-db` |
| The alias-learning tables | `fotech-db` |
| The LLM decision cache | `fotech-db` |
| The PDP authorization | `fotech-pdp` + `fotech-redis-pdp` |

LLM calls go out from `starlight` to whichever provider is configured (Vercel AI Gateway, direct Anthropic, Fireworks for Kimi). The voice agent calls out directly to Deepgram, Anthropic, and ElevenLabs.

## Related

- [`docs/rbac-architecture.md`](rbac-architecture.md) — what the PDP enforces
- [`docs/multi-agent-architecture.md`](multi-agent-architecture.md) — what `starlight` runs
- [`docs/augmented-engineering.md`](augmented-engineering.md) — how I administer all this from a chat window
