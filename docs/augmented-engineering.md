# Augmented Engineering

How I build FOTECH alone. The tooling, the patterns, and the workflows that let one person ship a multi-agent platform that would normally take a small team.

This isn't about "I use AI to write code". Everyone does that now. This is about **the engineering around the AI** — the dev environment, the orchestration between models, the security sandboxes, and the custom MCP connectors that let me run real commands on real infrastructure from a chat window.

## The mental model

I think of myself as the **architect and reviewer**, not the typist. The LLMs are the typists.

```
                  ┌────────────────────────┐
                  │   Me (architect)       │
                  │   - decides what       │
                  │   - reviews how        │
                  └───────────┬────────────┘
                              │
                              ▼
                  ┌────────────────────────┐
                  │  Claude (chat UI)      │
                  │  - planning            │
                  │  - dialogue            │
                  │  - light edits         │
                  └───────────┬────────────┘
                              │ delegates deep work via MCP
                              ▼
       ┌──────────────────────────────────────────┐
       │       Claude Code (CLI on VPS)            │
       │  - reads/writes files                     │
       │  - runs commands                          │
       │  - inspects DB                            │
       │  - executes within sandbox                │
       └────────────────┬─────────────────────────┘
                        │ second opinion / quality gate
                        ▼
              ┌──────────────────────────┐
              │   Gemini CLI              │
              │  - pre_check / post_check │
              │  - SAFE / RISKY / BLOCK  │
              └──────────────────────────┘
```

The chat UI does the talking. Claude Code does the doing. Gemini CLI does the checking. I do the deciding.

The two custom MCP connectors are the glue that make this work across machines.

## The two MCP connectors I built

### 1. `claude-code-bridge` for FOTECH (my own)

A FastMCP server on the Contabo VPS that exposes Claude Code's CLI as MCP tools. Claude in the chat UI (browser or desktop) connects via an HTTPS tunnel (Cloudflare or ngrok) and gets these tools:

| Tool | What it does |
|---|---|
| `run_claude_code(prompt, working_dir, allowed_tools, session_id)` | Spawns a Claude Code session on the VPS with the given prompt. Session can be resumed. |
| `execute_command(command, working_dir)` | Runs a shell command. Subject to allow/deny rules. |
| `read_file(path, max_bytes)` | Reads a file with a max-size guard. |
| `write_file(path, content)` | Writes a file (subject to path-based deny rules). |
| `list_directory(path)` | Lists a directory. |
| `list_sessions()` | Lists Claude Code sessions for resumption. |

The server lives at `/opt/claude-code-bridge/server.py` on the VPS. It's about 400 lines of Python (FastMCP plus the tunnel orchestration).

The architecture:

```
┌─────────────────┐
│   Claude.ai     │
│ (browser/app)   │
└────────┬────────┘
         │  HTTPS
         ▼
┌─────────────────────────┐
│  Cloudflare or ngrok    │
│  tunnel (TLS termination)│
└────────┬────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│  /opt/claude-code-bridge         │
│  ├─ server.py    (FastMCP)       │
│  ├─ auth.py      (HMAC tokens)   │
│  └─ sandbox.py   (allow/deny)    │
└──────────┬───────────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│  Claude Code CLI                 │
│  (subprocess, sandboxed)         │
└──────────────────────────────────┘
```

When I'm in the chat UI and say *"check the matcher cache size on prod"*, Claude resolves that to a `mcp__claude_code_contabo__execute_command` call → tunnel → bridge → `docker exec fotech-db psql ...` → result back to chat. End to end in ~2 seconds.

### 2. `plex-bridge` (delivered to a client)

I built a second MCP connector for a client who wanted **chat-controlled administration of their Plex media server**. Same architecture, different toolset:

| Tool | What it does |
|---|---|
| `plex_status()` | Returns Plex server health, version, library sizes |
| `plex_logs(n)` | Last n lines of Plex logs |
| `plex_restart()` | Restarts the Plex container |
| `execute_command()` | Generic VPS shell with deny rules tighter than FOTECH's |
| `read_file()` / `write_file()` | File access scoped to media config paths |
| `list_directory()` | Browse media library structure |
| `system_info()` | CPU/memory/disk snapshot |

The client now adds files, changes settings, restarts services, and inspects logs **by chatting with Claude**. No SSH, no admin panel, no command-line knowledge required.

This was the proof that the pattern transfers. The infrastructure is the same — only the toolset changes per domain.

## The sandbox: how Claude Code doesn't break things

When Claude Code can run arbitrary commands on a production VPS, you need rules. Otherwise one bad prompt destroys your project.

`~/.claude/settings.json` on the VPS defines what's allowed and what's not:

```json
{
  "permissions": {
    "allow": [
      "Bash(docker exec * :*)",
      "Bash(docker ps:*)",
      "Bash(docker logs *)",
      "Bash(psql -U *)",
      "Bash(grep:*)",
      "Bash(find:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(cp:*)",
      "Bash(curl:*)",
      "Read(/opt/fotech/**)",
      "Write(/opt/fotech/showcase/**)",
      "Write(/tmp/**)"
    ],
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(mv /opt/fotech/*)",
      "Bash(sudo:*)",
      "Bash(curl * | bash)",
      "Bash(curl * | sh)",
      "Write(/opt/fotech/backend/**)",
      "Write(/opt/fotech/source-admin/**)",
      "Write(/etc/**)",
      "Write(/root/.ssh/**)"
    ]
  }
}
```

The rules embody a philosophy: **let it do anything reversible, block anything destructive**.

- `Write(/opt/fotech/showcase/**)` allowed because this repo is what I'm currently building.
- `Write(/opt/fotech/backend/**)` denied because the production backend should only be modified through formal git workflow, not chat commands.
- `Bash(rm -rf:*)` denied period. If I genuinely need to delete something, I do it myself.

I treat these rules the same way I'd treat AWS IAM policies on a production account: explicit, audited, version-controlled.

## The `cc-buzon` mailbox: async between Claude and Claude Code

The MCP bridge is synchronous — Claude calls a tool and waits for the result. That's fine for quick commands but bad for long tasks like *"sweep the matcher v3 codebase for any leftover Anthropic-direct imports and propose a refactor"*.

For those, I use a **mailbox pattern** on shared disk:

```
/opt/fotech/cc-buzon/
├── inbox/        ← Claude (in chat) writes a task brief here
├── outbox/       ← Claude Code writes results here
├── archive/      ← Completed tasks (with reports)
└── context/      ← Shared state across sessions
```

A task brief is a markdown file with a structured header:

```markdown
# TASK S017-001 — Migrate matcher v3 cache key to include model

## Why
The current cache key doesn't include the model name. When swapping Haiku for Gemini,
old Haiku results pollute the cache and produce wrong matches.

## Scope
- src/matcher/juez-llm.js
- src/matcher/matcher-v3-llm.js
- evals/runner.js

## Out of scope
- Database schema changes (separate task)
- Anything in /opt/fotech/backend/

## Definition of done
- All cache keys include the active model.
- Old cache entries are not deleted but tagged 'pre-v2'.
- One smoke test passes against fixture F001.

## Verify by
- `git diff` is reviewable
- `node evals/runner.js --fixture F001` returns expected JSON
```

Claude Code reads `inbox/TASK-001.md`, plans, executes, writes a `REPORT-001.md` to `outbox/`. I read the report, accept or push back, and the cycle continues.

This is **async orchestration**. The chat UI doesn't block on Claude Code finishing a 20-minute refactor. I keep talking in chat about something else; Claude Code grinds on the task; I check `outbox/` when I'm ready.

## The quality gate: Gemini CLI as Director of Technical Quality

For changes that matter (sprint commits, schema migrations, anything affecting production), I route through Gemini CLI with a "Director Técnico de Calidad" prompt.

Two checks:

**pre_check** — before changes are applied:
```
SAFE   - proceed
RISKY  - proceed but flag specific concerns
BLOCK  - do not proceed, here's why
```

**post_check** — after changes are applied but before commit:
```
SAFE   - commit
RISKY  - commit with explicit issue list documented
BLOCK  - revert, here's the failure mode
```

The reason for using a **different model family** (Gemini, not Claude) is that two instances of the same model tend to share blind spots. A different model catches things Claude missed and vice versa.

This isn't theoretical: Gemini has caught real issues that Claude (and I) missed. The most memorable was a migration script that would have dropped a non-empty column. Gemini's post_check flagged it as BLOCK with the actual SQL row count from the dev database.

## What this enables

Concrete things this lets me do:

1. **Refactor a 5,000-line file in 20 minutes.** I describe the refactor in plain Spanish, Claude Code plans and executes, Gemini reviews, I commit. Manually it would be a half-day with high risk of breaking things.

2. **Debug a production issue from my phone.** I open the chat app, ask *"check why starlight is restarting"*, Claude calls `mcp__claude_code_contabo__execute_command` with `docker logs starlight --tail 50`, I see the cause, I dictate the fix, Claude Code applies it. Total time on the train: 4 minutes.

3. **Reproduce production state in a clean test.** Claude Code reads the schema, reads a fixture, builds a dockerized test env that mirrors prod. I review the test env, run my changes against it, then promote.

4. **Cross-session continuity without remembering anything.** Every session ends with a `SESSION-HANDOFF-CURRENT.md`. Next session, Claude reads it and we resume exactly where we left off, including the exact deuda técnica I was tracking. (See [`docs/decisions/004-cache-strategy.md`](decisions/004-cache-strategy.md) for the pattern.)

## Numbers

- **Cycle time reduction**: I estimate 5–10× compared to my pre-augmented baseline. Tasks that used to take a day take an hour or two. This is hard to measure rigorously, but it shows up in commit frequency and feature throughput.
- **Bug rate**: lower, but I credit that to Gemini's post_check more than to AI-assisted coding itself. The check catches things I would have shipped.
- **Cost**: maybe $30/month in LLM calls during heavy development sessions. Trivial compared to the time saved.

## What this is NOT

To be clear:

- **It's not autonomous.** Every commit is approved by me. Every irreversible action (deploy, DB migration, destructive command) requires explicit confirmation.
- **It's not a replacement for understanding the code.** I still read every line that gets committed. AI is a typist, not a deciding party.
- **It's not magic.** When the LLMs don't understand the domain, they generate plausible-looking garbage. The architecture and pre/post checks are what catch those moments.

## Reusability

The MCP bridge pattern is reusable for any "I want to control X from a chat" problem. The Plex client proves it generalizes. Future targets I'm considering for myself:

- Home Assistant (smart home from a chat)
- Personal Linux dev box from anywhere
- Kubernetes administration with sandbox rules

The 400 lines of `server.py` plus a fresh allow/deny ruleset turns any service into a chat-controllable one.

## Related

- [`docs/decisions/`](decisions/) — ADRs explaining why each major design choice was made
- [`docs/multi-agent-architecture.md`](multi-agent-architecture.md) — the agents this augmented dev environment builds
