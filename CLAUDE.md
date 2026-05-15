# OgaCode — Engineering Rules

## Project Identity
OgaCode is an **agentic AI coding assistant** built for Nigerian developers on constrained hardware and expensive mobile data. It's not autocomplete — it's a junior developer that reads files, runs tests, fixes bugs, and commits code autonomously. Every decision must pass the **Danfo Test**: would this work on a 4-year-old laptop in a Lagos cyber cafe with 450ms ping and 1GB of data left for the month?

## Build Status
> **What exists today:** A VS Code extension (`extension/`) + FastAPI proxy (`server/`) — the original architecture.
> **Where we're going:** Local-first Python CLI (`cli/`) as the core. The VS Code extension becomes a thin subprocess wrapper around the CLI.
> **Migration rule:** New features go into the CLI, not the extension or proxy. The proxy will be deleted when the CLI reaches feature parity.

---

## Architecture (Local-First)
```
[Python CLI] ──────────────────────────────────────────────
     ├─ Agent Loop (plan → act → observe → correct)
     ├─ Tool Registry: bash_exec, file_edit, ripgrep_search,
     │                 test_runner, git_ops, web_search
     ├─ Local State:
     │   ├─ SQLite cache (completions, history, embeddings)
     │   ├─ OS Keychain (API keys — never plaintext files)
     │   └─ Project memory (~/.ogacode/{sha256(cwd)}.db)
     └─ Provider Router:
         ├─ DeepSeek V3  (primary  — $0.27/1M tokens)
         ├─ Groq Llama 3.3 70B  (fallback — free tier)
         └─ Ollama Qwen 2.5 Coder  (offline — local inference)

[VS Code Extension] — optional thin UI
     └─ Spawns: ogacode --task "..." --stream --json
     └─ Streams output to webview panel
     └─ Zero business logic — CLI owns everything
```

**Why local-first beats the proxy:**
- Works in SSH sessions, Docker containers, CI pipelines
- Students run it on shared university servers with no VS Code
- No server bills, no single point of failure
- Data cost = pure API usage, no middleman overhead

---

## Target Runtime Constraints
| Metric | Budget | How to Measure |
|---|---|---|
| CLI cold start | < 1.2s on HDD | `hyperfine 'ogacode --help'` |
| Idle RAM | < 80MB | `ps aux` while idle |
| First token latency | < 2.0s | Logged in telemetry |
| Agent iteration | < 8s | Plan → Act → Observe cycle |
| Wheel size | < 2MB | `du -sh dist/*.whl` |
| API payload | < 12KB per request | Smart context pruning |
| Data per session | < 500KB average | `ogacode stats` |
| Cache lookup | < 50ms | SQLite SELECT on indexed hash |
| Offline feature coverage | ≥ 80% | Test with network disabled |

---

## Engineering Non-Negotiables

### Agent Loop (Hard Constraints)
The agent loop must stay under **300 lines**. If it grows past this, you've invented a bad LangChain. Extract tools, not abstractions.

```python
# src/agent/loop.py — must stay < 300 lines
def agent_loop(task: str, max_iterations: int = 10) -> AgentResult:
    """
    Converges on task completion using tool calls.
    Escalates to human after 2 consecutive failures on the same step.
    """
    plan = create_plan(task)           # LLM breaks task into steps
    for step in plan:
        result = execute_step(step)    # Calls bash_exec, file_edit, etc.
        if result.success:
            continue
        fix = propose_fix(step, result.error)   # LLM diagnoses failure
        retry = execute_step(fix)
        if not retry.success:
            return AgentResult(escalate=True, step=step, error=retry.error)
    return AgentResult(success=True)
```

### Tool Interface (Every Tool Must Implement This)
```python
class Tool:
    name: str          # bash_exec | file_edit | ripgrep_search | ...
    description: str   # LLM reads this to decide which tool to call

    def execute(self, **kwargs) -> ToolResult:
        # Timeout: 30s for bash, 10s for file ops
        # Sandbox: bash_exec restricted to project dir only
        # Must work offline or degrade gracefully
        pass

    def estimate_data_cost(self, **kwargs) -> int:
        # Return estimated bytes (used for data budget enforcement)
        pass
```

**Approved tools:** `bash_exec`, `file_edit`, `ripgrep_search`, `test_runner`, `git_ops`, `web_search` (DuckDuckGo HTML, no API key)

**Banned tools:** Browser automation (Playwright/Selenium — too heavy), image generation, database mutations outside project dir

### Dependencies (Zero-Bloat Policy)
**CLI core:** `click`, `rich`, `httpx`, `tiktoken`, `diskcache`, `tree-sitter`

No LangChain, no LlamaIndex, no heavy frameworks. Every dependency needs a justification in `pyproject.toml`:
```toml
# httpx — async HTTP with streaming + gzip support (245KB wheel)
httpx = "^0.27.0"
```

**Extension:** Zero npm dependencies beyond `@types/vscode`. No webpack, no Electron. esbuild only.

### API & Network (Multi-Provider Resilience)
```python
PROVIDERS = [
    {"name": "deepseek", "model": "deepseek-chat",          "timeout": 15},
    {"name": "groq",     "model": "llama-3.3-70b-versatile","timeout": 10},
    {"name": "ollama",   "model": "qwen2.5-coder:7b",       "timeout": 30},
]

async def call_llm(prompt: str, tools: list[Tool]) -> str:
    for provider in PROVIDERS:
        try:
            response = await provider.generate(prompt, tools, timeout=provider.timeout)
            cache_response(prompt, response)
            return response
        except (TimeoutError, APIError):
            continue
    raise AllProvidersFailedError("Run `ogacode doctor` to check your connection.")
```

Rules:
- **Timeouts always set.** 15s DeepSeek, 10s Groq, 30s Ollama.
- **Always gzip payloads.** `httpx` client with `Accept-Encoding: gzip`.
- **No retry without backoff.** 2s → 5s → 10s on 429/503.
- **Semantic cache.** Normalize prompts before hashing: lowercase + sort words. Cache hit = zero network call.
- **Monthly data cap.** Warn at 80% of cap, block at 100%. Configurable in `~/.ogacode/config.toml`.

### Security (Assume Shared Machines)
Nigerian students use cyber cafes, university labs, borrowed laptops. Assume the machine is shared.

```python
import keyring
# Store: keyring.set_password("ogacode", "deepseek_api_key", user_key)
# Read:  keyring.get_password("ogacode", "deepseek_api_key")
# Never write API keys to .env files or config files
```

Rules:
- **API keys in OS keychain only.** macOS Keychain, Windows Credential Manager, Linux `libsecret`.
- **Project memory is per-directory.** `~/.ogacode/projects/{sha256(cwd)}.db` — switching dirs = fresh context.
- **Redact secrets from logs.** Strip API keys, passwords, tokens before writing to SQLite.
- **Sandboxed bash.** `bash_exec` never allows `cd` outside project dir. Hard kill after 30s.
- **Audit log.** Every agent action appended to `~/.ogacode/audit.jsonl`.

### Data Efficiency (Every Kilobyte Counts)
₦1000/GB ≈ $0.60. A student on ₦2000/month can afford ~40,000 requests if each costs 50 bytes. Design for that.

1. **Send diffs, not full files.** 500-line file = 12KB. 8-line diff = 800 bytes. 93% smaller.
2. **Context pruning.** "Fix login bug" → ripgrep for "login" → send only those 5 files.
3. **Request batching.** Queue completions for 2 seconds, send in one roundtrip.
4. **Semantic cache.** `hash("Fix login bug") == hash("fix LOGIN bug")` — normalize before hashing.

### Offline Resilience
Assume network is unavailable 30% of the time (NEPA, expensive data, campus WiFi).

**Always works offline:** format, lint, test, file edit, git status/diff/commit, ripgrep search

**Needs network:** LLM planning, code generation, web search

```python
async def handle_task(task: str) -> str:
    try:
        return await agent_loop(task)
    except NetworkError:
        return local_fallback(task)   # format/lint/test/search by keyword
```

Failed LLM tasks queue to SQLite (`queued_requests` table) and retry when connectivity returns.

### VS Code Extension (Thin Wrapper Only)
The extension spawns the CLI and streams its output. No business logic in TypeScript.

```typescript
// extension/src/extension.ts — the ENTIRE agent integration
import { spawn } from 'child_process';

export async function runAgentTask(task: string, onChunk: (s: string) => void): Promise<void> {
    const proc = spawn('ogacode', ['--task', task, '--stream', '--json']);
    proc.stdout.on('data', chunk => onChunk(chunk.toString()));
    proc.stderr.on('data', chunk => onChunk(chunk.toString()));
    return new Promise((resolve, reject) => {
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    });
}
```

Extension rules:
- TypeScript strict mode. No `any` without `// justification` comment.
- esbuild only. No webpack. Bundle ≤ 500KB gzipped.
- Cold start ≤ 800ms. Lazy-load everything not needed at activation.
- CSP nonces on all webview script/style tags. No inline event handlers.
- `AbortController` timeouts on all fetch calls.

### Code Style
**Python:** Type hints on all signatures. Docstrings explain WHY, not WHAT. No global state — use FastAPI-style dependency injection patterns.

**TypeScript:** Strict mode. No framework beyond VS Code's native APIs.

**Both:** No comments explaining WHAT the code does — name things well. Comments only for non-obvious constraints or workarounds.

### Git Discipline
Branch naming: `feat/`, `fix/`, `perf/`, `docs/` prefixes.

Never commit: `.env`, API keys, `__pycache__`, `*.db`, `node_modules`.

Every PR needs a one-line **Danfo Test note**: does this change affect cold-start time, bundle size, or data usage?

---

## Error Messages (Student-Friendly)
```python
# BAD
raise TimeoutError("HTTPConnectionPool: Read timed out.")

# GOOD
raise NetworkError(
    "⚠️ Couldn't reach DeepSeek (timeout after 15s).\n"
    "Trying Groq next. If this keeps happening:\n"
    "  1. Check your connection: ogacode doctor\n"
    "  2. Switch to offline mode: ogacode --offline"
)
```

---

## Implementation Roadmap

### v0.1 — CLI MVP (current focus)
- [ ] CLI scaffold: `click` + `rich`
- [ ] DeepSeek + Groq integration via `httpx`
- [ ] Agent loop (< 300 lines)
- [ ] Tools: `bash_exec`, `file_edit`, `ripgrep_search`, `test_runner`
- [ ] SQLite cache + semantic hashing
- [ ] OS keychain integration
- [ ] Data usage tracking (`ogacode stats`)

### v0.2 — Resilience
- [ ] Groq + Ollama fallback chain
- [ ] Request queue (offline → retry on reconnect)
- [ ] Local tool fallbacks (format, lint without LLM)

### v0.3 — Extension Pivot
- [ ] Rewrite VS Code extension to spawn CLI subprocess
- [ ] Stream CLI JSON output to webview panel
- [ ] Delete `server/` (proxy) once CLI is stable
- [ ] Status bar: data usage, active provider

---

## The Danfo Test (Pre-Merge Checklist)
```bash
# 1. Cold start (must be < 1.2s)
hyperfine --warmup 1 --runs 3 'ogacode --help'

# 2. Bundle size (must be < 2MB wheel, < 500KB extension)
du -sh dist/*.whl
du -sh extension/dist/extension.js

# 3. Offline resilience (disable network, core features must work)
ogacode format main.py     # must work
ogacode "Fix login bug"    # must queue gracefully

# 4. Data per task (must be < 50KB average)
ogacode stats --reset && # run 10 tasks && ogacode stats --json
```

---

## Philosophy
**"Make it work offline, make it fast online, make it cheap always."**

Nigerian students don't have unlimited data or stable power. OgaCode must be the most respectful tool they use — respectful of their time, their money, and their reality.
