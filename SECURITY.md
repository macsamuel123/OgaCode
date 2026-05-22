# OgaCode Security Posture

This document honestly describes what OgaCode does and does not protect against.

---

## What OgaCode is

A local-first CLI tool that runs shell commands, edits files, and calls LLM APIs on your behalf.
It is not a hardened sandbox. It is a developer tool that assumes you trust the code it is running on.

---

## Tool execution (bash_exec)

- **Not a sandbox.** The banned command list (`rm`, `curl`, `dd`, `mkfs`, fork bombs, pipe-to-shell, etc.) prevents accidental damage from LLM mistakes. It does not prevent a determined attacker.
- **Working directory restriction.** Commands run inside the project directory. `cd ..` and `../` paths are blocked.
- **30-second timeout.** Long-running commands are killed automatically.
- **Do not run OgaCode on sensitive machines** (production servers, machines with access to secrets beyond the project) without additional containerization (Docker, nsjail, etc.).

## API keys

- Keys are stored in the **OS keychain** (macOS Keychain, Windows Credential Manager, Linux `libsecret`).
- Keys are **never written to disk** as plaintext.
- Keys are **never included in logs** or cache entries.
- In managed mode (`ogacode.serverUrl`), the user's personal API key is not needed — the server holds them.

## Cache

- The semantic response cache lives at `~/.ogacode/cache/` and is **stored unencrypted**.
- Cache contains LLM responses (code, text) but not API keys or user credentials.
- Set `OGACODE_NO_CACHE=1` to disable caching entirely for sensitive sessions.
- Cache has a 50MB size limit and a 7-day TTL per entry.

## Audit log

- Every tool execution is appended to `~/.ogacode/logs/audit.log`.
- Each entry contains: timestamp, tool name, truncated input (first 120 chars per field).
- The log is capped at 100 entries (oldest entries are dropped).
- The log is **not encrypted** and is readable by anyone with filesystem access to your home directory.

## Network

- LLM API calls are made over HTTPS with gzip compression.
- Set `OGACODE_DEBUG=1` to print request sizes and response status to stderr (keys are not printed).
- Web search uses DuckDuckGo HTML endpoint — no API key, no account required.
- Search results are scanned for prompt injection patterns and sanitized before being passed to the LLM.

## Reporting vulnerabilities

Open an issue at https://github.com/macsamuel123/OgaCode/issues and label it `security`.
For sensitive reports, email macsamuelfortune63@gmail.com directly.
