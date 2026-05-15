# OgaCode — Onboarding Guide

## What Is OgaCode?
OgaCode is a local-first, agentic AI coding assistant built for Nigerian developers on constrained hardware and expensive mobile data. Think of it as a junior developer that reads files, runs tests, fixes bugs, and commits code autonomously — all from a Python CLI that works offline and costs as little data as possible.

**The Danfo Test:** Every decision must work on a 4-year-old laptop in a Lagos cyber cafe with 450ms ping and 1GB of data left for the month.

---

## Project Structure
```
OgaCode/
├── cli/                        ← Active development (Python CLI)
│   └── src/ogacode/
│       ├── cli.py              ← Entry point: routes tasks or subcommands
│       ├── cache.py            ← Semantic cache (SQLite via diskcache)
│       ├── keychain.py         ← OS keychain wrapper (never plaintext keys)
│       ├── agent/
│       │   ├── loop.py         ← ReAct agent loop (< 300 lines, hard limit)
│       │   └── supervisor.py   ← Quality gate: second LLM pass after DONE
│       ├── providers/
│       │   └── router.py       ← Multi-provider fallback: DeepSeek → Groq → Ollama
│       └── tools/
│           ├── bash_exec.py    ← Sandboxed shell (PowerShell on Windows)
│           ├── file_edit.py    ← Create/read/append + snapshot before overwrite
│           ├── ripgrep_search.py ← rg with Python fallback
│           ├── test_runner.py  ← Auto-detects pytest / npm test / cargo test
│           └── web_search.py   ← DuckDuckGo HTML (no API key)
├── extension/                  ← VS Code extension (thin subprocess wrapper)
├── server/                     ← FastAPI proxy (being phased out)
└── CLAUDE.md                   ← Full engineering rules and architecture
```

**Rule:** New features go into `cli/`, not `extension/` or `server/`. The proxy gets deleted when CLI reaches feature parity.

---

## How the Agent Works
```
User task → create_plan() → agent_loop() → DONE → supervisor_review()
```

1. **Plan** — LLM breaks task into steps (JSON output)
2. **Act** — calls tools: `file_edit`, `bash_exec`, `ripgrep_search`, `test_runner`, `web_search`
3. **Observe** — tool result goes back to LLM
4. **Correct** — on failure, LLM diagnoses and retries; escalates after 2 consecutive failures
5. **Supervisor** — second LLM call verifies quality before returning DONE

---

## Provider Chain
| Provider | Model | Timeout | Cost |
|---|---|---|---|
| DeepSeek | deepseek-chat | 15s | $0.27/1M tokens |
| Groq | llama-3.3-70b-versatile | 10s | Free tier |
| Ollama | qwen2.5-coder:7b | 30s | Free (local) |

Keys stored in OS keychain (Windows Credential Manager / macOS Keychain / Linux libsecret). Run `ogacode setup` to configure.

---

## CLI Usage
```bash
ogacode "build me a login page"   # run a task
ogacode setup                      # configure API keys
ogacode doctor                     # check provider connectivity
ogacode stats                      # show data usage
ogacode rollback                   # restore files from last run

# Flags
ogacode --plan "build a REST API"  # show plan before executing
ogacode --stream "fix the bug"     # stream JSON events
ogacode --offline "format code"    # skip LLM, local tools only
```

---

## Windows Notes
- Shell is **PowerShell 5.1** — use `;` not `&&` to chain commands
- Use `New-Item`, `Get-ChildItem`, `Remove-Item` — not `mkdir`/`ls`/`rm`
- The agent's system prompt is OS-aware and will use correct syntax automatically

---

## Development Setup
```bash
cd cli
pip install -e .          # install CLI in editable mode
ogacode setup             # store API keys in keychain
ogacode doctor            # verify connectivity
```

Dependencies (zero-bloat policy): `click`, `rich`, `httpx`, `tiktoken`, `diskcache`, `keyring`

No LangChain, no LlamaIndex. Every dependency has a justification in `pyproject.toml`.

---

## Key Constraints
- Agent loop **must stay under 300 lines** — extract tools, not abstractions
- API payloads **< 12KB** per request (context pruning)
- CLI cold start **< 1.2s** on HDD
- Idle RAM **< 80MB**
- Wheel size **< 2MB**

See `CLAUDE.md` for the full engineering rules, architecture diagram, and pre-merge checklist.
