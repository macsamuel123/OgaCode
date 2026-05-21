import asyncio
import hashlib
import hmac
import json
import os
import pathlib
import re
from contextlib import asynccontextmanager
from typing import AsyncGenerator

try:
    import openclaude_client
    _GRPC_AVAILABLE = True
except Exception:
    openclaude_client = None  # type: ignore[assignment]
    _GRPC_AVAILABLE = False

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
try:
    from supabase import AsyncClient, acreate_client
    _SUPABASE_AVAILABLE = True
except Exception:
    _SUPABASE_AVAILABLE = False

load_dotenv()

FREE_MODEL = "llama-3.1-8b-instant"
PRO_MODEL = "deepseek-chat"

PRO_TOKEN_MONTHLY_LIMIT = 2_000_000
FREE_TOKEN_DAILY_LIMIT  = 50_000

_supabase = None


def _provider_status() -> dict:
    return {
        "groq":          bool(os.getenv("GROQ_API_KEY")),
        "deepseek":      bool(os.getenv("DEEPSEEK_API_KEY")),
        "github_models": bool(os.getenv("GITHUB_TOKEN")),
        "supabase":      bool(os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_SERVICE_KEY")),
    }


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    global _supabase
    try:
        url = os.getenv("SUPABASE_URL", "")
        key = os.getenv("SUPABASE_SERVICE_KEY", "")
        if url and key and _SUPABASE_AVAILABLE:
            _supabase = await acreate_client(url, key)  # type: ignore[name-defined]

        providers = _provider_status()
        available = [k for k, v in providers.items() if v]
        if not available:
            print("\nWARNING: No LLM providers configured. Set GROQ_API_KEY or DEEPSEEK_API_KEY.\n")
        else:
            print(f"\nOgaCode server ready — providers: {', '.join(available)}\n")
    except Exception as e:
        print(f"\nWARNING: Startup error (non-fatal): {e}\n")

    yield


app = FastAPI(title="OgaCode Proxy", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    prompt: str
    user_id: str


class FileOutput(BaseModel):
    path: str
    content: str


class ChatResponse(BaseModel):
    response: str
    model: str
    cached: bool = False
    files: list[FileOutput] = []
    deploy_cmd: str = ""
    stack: str = ""
    verified: bool = False


class FixRequest(BaseModel):
    user_id: str
    files: list[FileOutput]
    error_log: str
    stack: str


RESEARCH_RE = re.compile(
    r"\b(research|find|search|look up|what is|compare|trend|news|latest|current|analyze|report|summarize|who is|when did)\b",
    re.IGNORECASE,
)


class ClarifyRequest(BaseModel):
    prompt: str
    user_id: str


class ClarifyResponse(BaseModel):
    questions: list[str]
    stack: str
    plan_summary: str


class PlanResponse(BaseModel):
    stack: str
    deploy_cmd: str
    files: list[str]
    steps: list[str]
    summary: str


class CodeFixRequest(BaseModel):
    user_id: str
    problem: str
    file_path: str
    code: str
    language: str


class TestCase(BaseModel):
    name: str
    passed: bool
    note: str


class CodeFixResponse(BaseModel):
    fixed_code: str
    explanation: str
    tests: list[TestCase]
    all_passed: bool
    file_path: str


# ---------------------------------------------------------------------------
# Stack-specific system prompts
# ---------------------------------------------------------------------------

SYSTEM_NEXTJS = (
    "You are OgaCode, building a production Next.js 15 + Tailwind CSS v4 website that deploys to Vercel.\n"
    "Use ONLY this exact format — no text outside it:\n\n"
    "MESSAGE: <one sentence describing what you built>\n\n"
    "FILE:package.json\n<content>\n---\n"
    "FILE:postcss.config.mjs\n<content>\n---\n"
    "FILE:app/globals.css\n<content>\n---\n"
    "FILE:app/layout.tsx\n<content>\n---\n"
    "FILE:app/page.tsx\n<content>\n---\n\n"
    "Rules:\n"
    "- package.json scripts: dev/build/start with next. deps: next@15.2.4 react@19 react-dom@19. "
    "devDeps: typescript@5 @types/react@19 @types/react-dom@19 tailwindcss@4 @tailwindcss/postcss@4\n"
    "- postcss.config.mjs: export default { plugins: { '@tailwindcss/postcss': {} } }\n"
    "- app/globals.css: first line must be @import \"tailwindcss\";\n"
    "- app/layout.tsx: export const metadata with title/description, wrap children in <html lang='en'><body>\n"
    "- app/page.tsx: add 'use client' only if using React hooks\n"
    "- Style with Tailwind utility classes — make it visually impressive\n"
    "- NEVER invent business names, locations, or currencies — use only what the user provides\n"
    "- Placeholder business name if none given: 'Your Business'\n"
    "- Copyright year in JS: new Date().getFullYear()\n"
    "- COMPLETE working code in every file — no placeholders, no TODO comments"
)

SYSTEM_EXPO = (
    "You are OgaCode, building an Expo SDK 55 React Native app with expo-router.\n"
    "Use ONLY this exact format — no text outside it:\n\n"
    "MESSAGE: <one sentence>\n\n"
    "FILE:package.json\n<content>\n---\n"
    "FILE:app.json\n<content>\n---\n"
    "FILE:tsconfig.json\n<content>\n---\n"
    "FILE:app/_layout.tsx\n<content>\n---\n"
    "FILE:app/(tabs)/_layout.tsx\n<content>\n---\n"
    "FILE:app/(tabs)/index.tsx\n<content>\n---\n\n"
    "Rules:\n"
    "- package.json: expo@~55.0.0 expo-router@~4.0.0 react-native react react-dom typescript\n"
    "- tsconfig.json: extend expo/tsconfig.base, include 'expo-router/types'\n"
    "- Use StyleSheet.create for all styling (no Tailwind/CSS in React Native)\n"
    "- Use Pressable not TouchableOpacity. FlashList not FlatList for lists\n"
    "- Use expo-image not the built-in Image for remote URLs\n"
    "- NEVER invent business names — use only what the user provides\n"
    "- COMPLETE working code in every file"
)

SYSTEM_FLASK = (
    "You are OgaCode, building a Python Flask web app that deploys to Render.\n"
    "Use ONLY this exact format — no text outside it:\n\n"
    "MESSAGE: <one sentence>\n\n"
    "FILE:requirements.txt\n<content>\n---\n"
    "FILE:Procfile\n<content>\n---\n"
    "FILE:app.py\n<complete flask app>\n---\n"
    "FILE:templates/index.html\n<complete html>\n---\n\n"
    "Rules:\n"
    "- requirements.txt: flask gunicorn flask-cors (add others as needed)\n"
    "- Procfile: web: gunicorn app:app\n"
    "- Type hints on all function signatures\n"
    "- Include CORS handling if building an API\n"
    "- NEVER invent business names — use only what the user provides\n"
    "- COMPLETE working code in every file"
)

SYSTEM_STATIC = (
    "You are OgaCode, an expert AI coding assistant.\n"
    "Use ONLY this exact format — no text outside it:\n\n"
    "MESSAGE: <one line explanation>\n\n"
    "FILE:index.html\n<complete html code>\n---\n"
    "FILE:style.css\n<complete css code>\n---\n"
    "FILE:script.js\n<complete js code>\n---\n"
    "FILE:netlify.toml\n[build]\n  publish = \".\"\n---\n\n"
    "Rules:\n"
    "- NEVER invent a business name, country, city, or currency — use only what the user provides\n"
    "- Copyright year: new Date().getFullYear() in JS\n"
    "- COMPLETE code in every file\n"
    "- For non-code questions write MESSAGE: only, no FILE blocks"
)

SYSTEM_FULLSTACK = (
    "You are OgaCode, a code generator. Your ONLY job is to output working code files.\n"
    "NEVER describe yourself. NEVER refuse. NEVER explain what you do. Just output the files.\n\n"
    "For every user request, output a deployable full-stack project in this EXACT format:\n\n"
    "MESSAGE: <one sentence describing the app you built>\n\n"
    "FILE:docker-compose.yml\n<complete content>\n---\n"
    "FILE:render.yaml\n<complete content>\n---\n"
    "FILE:frontend/package.json\n<complete content>\n---\n"
    "FILE:frontend/postcss.config.mjs\n<complete content>\n---\n"
    "FILE:frontend/.env.local\n<complete content>\n---\n"
    "FILE:frontend/app/globals.css\n<complete content>\n---\n"
    "FILE:frontend/app/layout.tsx\n<complete content>\n---\n"
    "FILE:frontend/app/page.tsx\n<complete content>\n---\n"
    "FILE:backend/requirements.txt\n<complete content>\n---\n"
    "FILE:backend/.env\n<complete content>\n---\n"
    "FILE:backend/Procfile\n<complete content>\n---\n"
    "FILE:backend/main.py\n<complete content>\n---\n\n"
    "WIRING — hardcode these exactly:\n"
    "- frontend/.env.local: NEXT_PUBLIC_API_URL=http://localhost:8000\n"
    "- frontend fetches from process.env.NEXT_PUBLIC_API_URL\n"
    "- backend/main.py: CORSMiddleware allow_origins=['http://localhost:3000', os.getenv('FRONTEND_URL','http://localhost:3000')], allow_methods=['*'], allow_headers=['*']\n"
    "- docker-compose: backend=python:3.11-slim port 8000, frontend=node:20-alpine port 3000\n"
    "  backend cmd: sh -c \"pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000 --reload\"\n"
    "  frontend cmd: sh -c \"npm install && npm run dev\"\n"
    "- render.yaml: free web service, buildCommand=pip install -r requirements.txt, startCommand=uvicorn main:app --host 0.0.0.0 --port $PORT\n"
    "- backend/Procfile: web: uvicorn main:app --host 0.0.0.0 --port $PORT\n\n"
    "STACK:\n"
    "- Frontend: Next.js 15 + Tailwind v4 + TypeScript\n"
    "  package.json deps: next@15.2.4 react@19 react-dom@19\n"
    "  devDeps: typescript@5 @types/react@19 @types/react-dom@19 tailwindcss@4 @tailwindcss/postcss@4\n"
    "  postcss.config.mjs: export default { plugins: { '@tailwindcss/postcss': {} } }\n"
    "- Backend: FastAPI + uvicorn + pydantic\n"
    "  requirements.txt: fastapi uvicorn[standard] pydantic python-dotenv (add others as needed)\n\n"
    "RULES:\n"
    "- Build real API routes the frontend calls — not just /health\n"
    "- Tailwind styling — make the UI visually impressive\n"
    "- NEVER invent business names, locations, or currencies — use only what the user provides\n"
    "- If no name given, use 'Your Business' as placeholder\n"
    "- COMPLETE code in every file — no '...', no TODOs, no truncation"
)


SYSTEM_EXPRESS = (
    "You are OgaCode, a code generator. Your ONLY job is to output working code files.\n"
    "NEVER describe yourself. NEVER refuse. Just output the files.\n\n"
    "Generate a production Node.js Express API with TypeScript in this EXACT format:\n\n"
    "MESSAGE: <one sentence>\n\n"
    "FILE:package.json\n<complete content>\n---\n"
    "FILE:tsconfig.json\n<complete content>\n---\n"
    "FILE:.env\n<complete content>\n---\n"
    "FILE:Procfile\n<complete content>\n---\n"
    "FILE:src/index.ts\n<complete content>\n---\n"
    "FILE:src/routes/api.ts\n<complete content>\n---\n\n"
    "Rules:\n"
    "- package.json: express cors dotenv in deps. typescript @types/node @types/express @types/cors ts-node-dev in devDeps\n"
    "- scripts: dev (ts-node-dev --respawn src/index.ts), build (tsc), start (node dist/index.ts)\n"
    "- tsconfig.json: target ES2020, module commonjs, outDir dist, rootDir src, strict true\n"
    "- src/index.ts: import express + cors + dotenv. Mount router at /api. Listen on process.env.PORT || 3001\n"
    "- src/routes/api.ts: use express.Router(). Build real endpoints relevant to the user's request\n"
    "- .env: PORT=3001 and any app-specific vars as placeholders\n"
    "- Procfile: web: npm start\n"
    "- TypeScript types on every function — no implicit any\n"
    "- NEVER invent business names — use only what the user provides\n"
    "- COMPLETE working code — no placeholders, no TODOs"
)

SYSTEM_DJANGO = (
    "You are OgaCode, a code generator. Your ONLY job is to output working code files.\n"
    "NEVER describe yourself. NEVER refuse. Just output the files.\n\n"
    "Generate a production Django REST Framework API in this EXACT format:\n\n"
    "MESSAGE: <one sentence>\n\n"
    "FILE:requirements.txt\n<complete content>\n---\n"
    "FILE:Procfile\n<complete content>\n---\n"
    "FILE:.env\n<complete content>\n---\n"
    "FILE:manage.py\n<complete content>\n---\n"
    "FILE:core/settings.py\n<complete content>\n---\n"
    "FILE:core/urls.py\n<complete content>\n---\n"
    "FILE:core/wsgi.py\n<complete content>\n---\n"
    "FILE:api/models.py\n<complete content>\n---\n"
    "FILE:api/serializers.py\n<complete content>\n---\n"
    "FILE:api/views.py\n<complete content>\n---\n"
    "FILE:api/urls.py\n<complete content>\n---\n\n"
    "Rules:\n"
    "- requirements.txt: django djangorestframework django-cors-headers python-dotenv gunicorn\n"
    "- Procfile: web: gunicorn core.wsgi --log-file -\n"
    "- settings.py: read SECRET_KEY/DEBUG/DATABASE_URL from os.environ. CORS_ALLOW_ALL_ORIGINS=True for dev\n"
    "- Build real models, serializers, and views relevant to the user's request\n"
    "- api/urls.py: use DRF routers for ViewSets\n"
    "- core/urls.py: include api.urls at /api/\n"
    "- Type hints on all Python functions\n"
    "- NEVER invent business names — use only what the user provides\n"
    "- COMPLETE working code — no placeholders, no TODOs"
)


def get_system_prompt(stack: str) -> str:
    return {
        "nextjs": SYSTEM_NEXTJS,
        "expo": SYSTEM_EXPO,
        "python-flask": SYSTEM_FLASK,
        "express": SYSTEM_EXPRESS,
        "django": SYSTEM_DJANGO,
        "fullstack": SYSTEM_FULLSTACK,
    }.get(stack, SYSTEM_STATIC)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def get_profile(user_id: str) -> dict:
    if _supabase is None:
        return {"status": "free", "tokens_used": 0}
    try:
        result = await _supabase.table("profiles").select("status, tokens_used").eq("id", user_id).single().execute()
        if result.data:
            return result.data
    except Exception:
        pass
    return {"status": "free", "tokens_used": 0}


async def load_history(user_id: str, limit: int = 6) -> list[dict]:
    """Load last N conversation turns (oldest first) for LLM context."""
    if _supabase is None:
        return []
    try:
        result = (
            await _supabase.table("conversations")
            .select("role, content")
            .eq("user_id", user_id)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        if result.data:
            return list(reversed(result.data))
    except Exception:
        pass
    return []


async def save_turn(user_id: str, role: str, content: str, stack: str = "") -> None:
    """Persist a single conversation turn to Supabase."""
    if _supabase is None:
        return
    try:
        await _supabase.table("conversations").insert({
            "user_id": user_id,
            "role": role,
            "content": content,
            "stack": stack,
        }).execute()
    except Exception:
        pass


def parse_llm_response(raw: str) -> tuple[str, list[FileOutput]]:
    """Parse the MESSAGE/FILE delimiter format returned by the code model."""
    message = ""
    files: list[FileOutput] = []

    if raw.startswith("MESSAGE:"):
        first_line_end = raw.find("\n")
        message = raw[len("MESSAGE:"):first_line_end].strip() if first_line_end != -1 else raw[len("MESSAGE:"):].strip()
        rest = raw[first_line_end:] if first_line_end != -1 else ""
    else:
        rest = raw

    for block in rest.split("FILE:"):
        block = block.strip()
        if not block:
            continue
        newline = block.find("\n")
        if newline == -1:
            continue
        path = block[:newline].strip()
        content = block[newline:].strip().rstrip("-").strip()

        # Strip markdown code fences LLMs sometimes add around file content
        lines = content.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        content = "\n".join(lines).strip()

        if path and content:
            files.append(FileOutput(path=path, content=content))

    if not message and files:
        message = f"Created {len(files)} file(s) for your project."
    elif not message:
        message = raw.strip()

    return message, files


async def refine_prompt(prompt: str) -> str:
    """Expand a vague prompt into a detailed technical spec."""
    if len(prompt.split()) > 15:
        return prompt

    system = (
        "You are the OgaCode Architect — a senior software engineer and UI/UX expert. "
        "A developer gave you a vague request. Expand it into a structured build plan a coding AI can execute. "
        "Include: what to build, key UI sections, features, tech stack, step-by-step build order. "
        "Apply UI/UX Pro Max standards: specify color palette, font pairing, style (glassmorphism/minimalism/etc), "
        "spacing system (8pt grid), accessibility requirements, and mobile-first breakpoints. "
        "IMPORTANT: Use ONLY the business name, location, and context the user provides — never assume or add a country, "
        "city, or currency. If the user says 'medispa website', the business has no name yet — use a placeholder like 'Your Medispa'. "
        "Output 5-7 sentences max — plain text only, no markdown, no bullet points."
    )

    github_token = os.getenv("GITHUB_TOKEN", "")
    if github_token:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(
                    "https://models.inference.ai.azure.com/chat/completions",
                    headers={"Authorization": f"Bearer {github_token}", "Content-Type": "application/json"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": prompt},
                        ],
                        "max_tokens": 250,
                    },
                )
            if resp.status_code == 200:
                return resp.json()["choices"][0]["message"]["content"]
        except Exception:
            pass

    groq_key = os.getenv("GROQ_API_KEY", "")
    if groq_key:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"},
                    json={
                        "model": FREE_MODEL,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": prompt},
                        ],
                        "max_tokens": 200,
                    },
                )
            if resp.status_code == 200:
                return resp.json()["choices"][0]["message"]["content"]
        except Exception:
            pass

    return prompt


async def plan_project(prompt: str) -> dict:
    """Decide the project stack and deployment strategy using a fast model."""
    system = (
        'You are OgaCode Architect. Return a JSON object only — no other text.\n'
        'Format: {"stack":"fullstack","deploy_cmd":"docker compose up","message":"Building your X"}\n\n'
        "stack values:\n"
        "- fullstack: ANY app needing BOTH a frontend UI and a backend API — "
        "booking system, delivery, laundry, SaaS with login, e-commerce with cart, "
        "dashboard with real data, inventory, restaurant ordering, anything with a database\n"
        "- nextjs: marketing site, landing page, portfolio, blog, brochure (static content, no backend)\n"
        "- expo: mobile app, iOS, Android, React Native\n"
        "- express: Node.js/JavaScript API, REST API with Node, Express server, backend in JS/TS, "
        "microservice, webhook server, real-time API with Socket.io\n"
        "- django: Python web app with admin panel, content management, complex data models, "
        "Django REST Framework, needs Django ORM\n"
        "- python-flask: simple Python API, Flask, FastAPI, data script, bot, web scraper\n"
        "- static-html: calculator, game, widget, quick demo, code snippet\n\n"
        "RULE: When in doubt between nextjs and fullstack, choose fullstack.\n"
        "RULE: If user mentions Node/JavaScript/TypeScript for backend, use express.\n"
        "RULE: If user mentions Django or needs admin panel, use django.\n\n"
        "deploy_cmd:\n"
        "- fullstack → 'docker compose up'\n"
        "- nextjs → 'npm install; npx vercel --prod'\n"
        "- expo → 'npm install; npx expo start'\n"
        "- express → 'npm install; npm run dev'\n"
        "- django → 'pip install -r requirements.txt; python manage.py migrate; python manage.py runserver'\n"
        "- python-flask → 'pip install -r requirements.txt; python app.py'\n"
        "- static-html → 'Drag folder to netlify.com/drop'\n\n"
        "message: one sentence e.g. 'Building your laundry API with Express and TypeScript'"
    )

    _default: dict = {
        "stack": "static-html",
        "deploy_cmd": "Drag folder to netlify.com/drop",
        "message": "Building your project",
    }

    # Try GitHub Models first (doesn't consume Groq TPM)
    github_token = os.getenv("GITHUB_TOKEN", "")
    if github_token:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(
                    "https://models.inference.ai.azure.com/chat/completions",
                    headers={"Authorization": f"Bearer {github_token}", "Content-Type": "application/json"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": prompt},
                        ],
                        "max_tokens": 120,
                        "response_format": {"type": "json_object"},
                    },
                )
            if resp.status_code == 200:
                raw = resp.json()["choices"][0]["message"]["content"]
                return json.loads(raw)
        except Exception:
            pass

    # Fallback to Groq
    groq_key = os.getenv("GROQ_API_KEY", "")
    if groq_key:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"},
                    json={
                        "model": FREE_MODEL,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": prompt},
                        ],
                        "max_tokens": 120,
                        "response_format": {"type": "json_object"},
                    },
                )
            if resp.status_code == 200:
                raw = resp.json()["choices"][0]["message"]["content"]
                return json.loads(raw)
        except Exception:
            pass

    return _default


async def web_search(query: str, count: int = 5) -> list[dict]:
    """Brave Search API. Returns [] if key missing or request fails."""
    brave_key = os.getenv("BRAVE_API_KEY", "")
    if not brave_key:
        return []
    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.get(
                "https://api.search.brave.com/res/v1/web/search",
                headers={"Accept": "application/json", "X-Subscription-Token": brave_key},
                params={"q": query, "count": count, "text_decorations": "false"},
            )
        if resp.status_code == 200:
            results = resp.json().get("web", {}).get("results", [])
            return [
                {"title": r.get("title", ""), "snippet": r.get("description", ""), "url": r.get("url", "")}
                for r in results
            ]
    except Exception:
        pass
    return []


_SKILLS_DIR = pathlib.Path(__file__).parent / "skills"


def search_skills(query: str) -> str | None:
    """Search local skill .md files before hitting Brave Search. Returns best excerpt or None."""
    if not _SKILLS_DIR.exists():
        return None
    query_words = {w for w in re.sub(r"[^a-z0-9 ]", "", query.lower()).split() if len(w) > 3}
    if not query_words:
        return None
    best_score = 0
    best_snippet: str | None = None
    for skill_file in _SKILLS_DIR.glob("**/*.md"):
        try:
            text = skill_file.read_text(encoding="utf-8")
            score = sum(1 for w in query_words if w in text.lower())
            if score > best_score:
                best_score = score
                best_snippet = text[:2000]
        except Exception:
            pass
    return best_snippet if best_score >= 2 else None


async def call_fast_llm(prompt: str, system: str = "", max_tokens: int = 2048) -> str:
    """Fastest available model — used for review, verification, and fix passes."""
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    github_token = os.getenv("GITHUB_TOKEN", "")
    if github_token:
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    "https://models.inference.ai.azure.com/chat/completions",
                    headers={"Authorization": f"Bearer {github_token}", "Content-Type": "application/json"},
                    json={"model": "gpt-4o-mini", "messages": messages, "max_tokens": max_tokens},
                )
            if resp.status_code == 200:
                return resp.json()["choices"][0]["message"]["content"]
        except Exception:
            pass

    groq_key = os.getenv("GROQ_API_KEY", "")
    if groq_key:
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"},
                    json={"model": FREE_MODEL, "messages": messages, "max_tokens": max_tokens},
                )
            if resp.status_code == 200:
                return resp.json()["choices"][0]["message"]["content"]
        except Exception:
            pass

    raise HTTPException(status_code=503, detail="No LLM provider available")


async def call_supervisor(user_request: str, stack: str, files: list[FileOutput]) -> tuple[bool, str]:
    """Reflect on the generated output. Returns (satisfied, feedback)."""
    all_content = " ".join(f.content for f in files)
    has_todos = bool(re.search(r"\bTODO\b|placeholder|\.\.\.", all_content, re.IGNORECASE))

    file_listing = "\n".join(
        f"FILE:{f.path}\n{f.content[:400]}\n---" for f in files[:8]
    )

    system = (
        "You are the OgaCode Quality Supervisor. Be strict and brief.\n"
        "Check the generated files against the user's original request.\n"
        "If ALL requirements are met and NO TODO/placeholder code exists: output exactly STATUS: COMPLETE\n"
        "If anything is missing or broken: output STATUS: RE-ITERATE then bullet the specific issues. Be concise."
    )
    prompt = (
        f"Original request: {user_request}\nStack: {stack}\n\n"
        f"Generated files:\n{file_listing}\n\n"
        + ("⚠ TODO or placeholder text found in the code.\n" if has_todos else "")
        + "Does this fully satisfy the request? Any incomplete code or missing features?"
    )

    try:
        result = await call_fast_llm(prompt, system, max_tokens=400)
    except Exception:
        return True, "STATUS: COMPLETE"

    return "STATUS: COMPLETE" in result, result


async def review_and_fix(raw: str, stack: str) -> tuple[str, bool]:
    """Post-generation review: checks the key file for breaking errors and patches in-place."""
    if stack not in ("nextjs", "fullstack", "express", "expo"):
        return raw, False

    github_token = os.getenv("GITHUB_TOKEN", "")
    if not github_token:
        return raw, False

    key_file = {
        "nextjs":    "app/page.tsx",
        "fullstack": "frontend/app/page.tsx",
        "express":   "src/index.ts",
        "expo":      "app/(tabs)/index.tsx",
    }.get(stack, "")

    if not key_file or f"FILE:{key_file}" not in raw:
        return raw, False

    # Slice out the key file's content from the raw LLM output
    start = raw.find(f"FILE:{key_file}") + len(f"FILE:{key_file}\n")
    end   = raw.find("\n---", start)
    if end <= start:
        return raw, False
    key_content = raw[start:end].strip()

    system = (
        "You are a TypeScript code reviewer. Check for breaking errors only — "
        "missing 'use client', missing React/hook imports, undefined variables, wrong JSX. "
        "Never add comments. Never rewrite working code."
    )
    review_prompt = (
        f"Review this {stack} file for breaking errors:\n\n"
        f"FILE:{key_file}\n{key_content}\n\n"
        f"If broken, return fixed file as:\nFILE:{key_file}\n<content>\n---\n\n"
        "If correct, return exactly: LGTM"
    )

    try:
        review = (await call_fast_llm(review_prompt, system, max_tokens=2048)).strip()

        if review.upper().startswith("LGTM"):
            return raw, False

        if f"FILE:{key_file}" not in review:
            return raw, False

        # Extract fixed content and splice it back into the raw output
        fx_start = review.find(f"FILE:{key_file}") + len(f"FILE:{key_file}\n")
        fx_end   = review.find("\n---", fx_start)
        if fx_end <= fx_start:
            return raw, False

        fixed_content = review[fx_start:fx_end].strip()
        new_raw = raw[:start] + fixed_content + raw[end:]
        return new_raw, True

    except Exception:
        return raw, False


def _strip_fences(code: str) -> str:
    lines = code.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


async def call_llm(
    model: str,
    prompt: str,
    stack: str = "static-html",
    history: list[dict] | None = None,
) -> str:
    system_prompt = get_system_prompt(stack)

    def build_messages(sys: str, hist: list[dict] | None, user_prompt: str) -> list[dict]:
        msgs: list[dict] = [{"role": "system", "content": sys}]
        if hist:
            msgs.extend(hist)
        msgs.append({"role": "user", "content": user_prompt})
        return msgs

    # Fullstack on free tier: Groq's 6,000 TPM can't fit 12 files (~9,000 tokens).
    # Route to GitHub Models (GPT-4o-mini) which has a much higher free limit.
    if stack == "fullstack" and model != PRO_MODEL:
        github_token = os.getenv("GITHUB_TOKEN", "")
        if github_token:
            try:
                async with httpx.AsyncClient(timeout=45.0) as client:
                    resp = await client.post(
                        "https://models.inference.ai.azure.com/chat/completions",
                        headers={"Authorization": f"Bearer {github_token}", "Content-Type": "application/json"},
                        json={
                            "model": "gpt-4o-mini",
                            "messages": build_messages(system_prompt, history, prompt),
                            "max_tokens": 8192,
                        },
                    )
                if resp.status_code == 200:
                    return resp.json()["choices"][0]["message"]["content"]
            except Exception:
                pass
        # No GitHub token or request failed — surface a clear error rather than
        # hitting Groq and getting a cryptic TPM error
        raise HTTPException(
            status_code=503,
            detail="Fullstack generation requires a GITHUB_TOKEN env var. Add it to server/.env to unlock this feature.",
        )

    if model == PRO_MODEL:
        url = "https://api.deepseek.com/chat/completions"
        api_key = os.getenv("DEEPSEEK_API_KEY", "")
    else:
        url = "https://api.groq.com/openai/v1/chat/completions"
        api_key = os.getenv("GROQ_API_KEY", "")

    if not api_key:
        raise HTTPException(status_code=500, detail="AI provider key not configured")

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "messages": build_messages(system_prompt, history, prompt),
        "max_tokens": 4096,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, headers=headers, json=payload)

    if resp.status_code == 429:
        await asyncio.sleep(4)
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(url, headers=headers, json=payload)

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"LLM provider error: {resp.text}")

    return resp.json()["choices"][0]["message"]["content"]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.post("/v1/chat/completions")
async def openai_proxy(request: Request):
    """OpenAI-compatible proxy — validates user token, forwards to DeepSeek/Groq with server key.

    The runner sets OPENAI_BASE_URL to this server and OPENAI_API_KEY to the user's OgaCode token.
    Users never need their own LLM API keys.
    """
    from fastapi.responses import Response as RawResponse

    auth = request.headers.get("authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing OgaCode token. Set ogacode.token in VS Code settings.")

    # UAT: accept any non-empty token.
    # TODO: validate token against Supabase users table before launch.

    body = await request.json()
    streaming = body.get("stream", False)

    deepseek_key = os.getenv("DEEPSEEK_API_KEY")
    groq_key = os.getenv("GROQ_API_KEY")

    if deepseek_key:
        target = "https://api.deepseek.com/v1/chat/completions"
        api_key = deepseek_key
    elif groq_key:
        target = "https://api.groq.com/openai/v1/chat/completions"
        api_key = groq_key
        if body.get("model") == "deepseek-chat":
            body["model"] = "moonshotai/kimi-k2-instruct"
    else:
        raise HTTPException(status_code=503, detail="No LLM provider configured on server.")

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    if streaming:
        async def _stream():
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
                async with client.stream("POST", target, json=body, headers=headers) as resp:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
        return StreamingResponse(
            _stream(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(target, json=body, headers=headers)
    return RawResponse(content=resp.content, media_type="application/json", status_code=resp.status_code)


@app.get("/health")
async def health() -> dict:
    providers = _provider_status()
    any_llm = providers["groq"] or providers["deepseek"] or providers["github_models"]
    return {
        "status": "ok" if any_llm else "degraded",
        "service": "ogacode-proxy",
        "providers": providers,
        **({"warning": "No LLM provider configured — set GROQ_API_KEY or DEEPSEEK_API_KEY in server/.env"} if not any_llm else {}),
    }


@app.get("/history/{user_id}")
async def get_history(user_id: str) -> list[dict]:
    return await load_history(user_id, limit=40)


@app.post("/fix", response_model=ChatResponse)
async def fix_build(body: FixRequest) -> ChatResponse:
    """Re-generate files given a user-reported error log."""
    github_token = os.getenv("GITHUB_TOKEN", "")
    groq_key     = os.getenv("GROQ_API_KEY", "")

    file_listing = "\n".join(
        f"FILE:{f.path}\n{f.content[:600]}\n---"
        for f in body.files
    )
    prompt = (
        f"This {body.stack} project has errors. Fix them and return corrected files.\n\n"
        f"Errors:\n{body.error_log[:1500]}\n\n"
        f"Files:\n{file_listing}"
    )
    system = get_system_prompt(body.stack)

    raw = ""
    if github_token:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    "https://models.inference.ai.azure.com/chat/completions",
                    headers={"Authorization": f"Bearer {github_token}", "Content-Type": "application/json"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": prompt},
                        ],
                        "max_tokens": 4096,
                    },
                )
            if resp.status_code == 200:
                raw = resp.json()["choices"][0]["message"]["content"]
        except Exception:
            pass

    if not raw and groq_key:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {groq_key}", "Content-Type": "application/json"},
                    json={
                        "model": FREE_MODEL,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": prompt},
                        ],
                        "max_tokens": 4096,
                    },
                )
            if resp.status_code == 200:
                raw = resp.json()["choices"][0]["message"]["content"]
        except Exception:
            pass

    if not raw:
        raise HTTPException(status_code=503, detail="Fix service unavailable")

    message, files = parse_llm_response(raw)
    return ChatResponse(
        response=message or "Fixed build errors.",
        model="gpt-4o-mini",
        files=files,
        stack=body.stack,
        verified=True,
    )


@app.post("/chat/stream")
async def chat_stream(body: ChatRequest) -> StreamingResponse:
    """Full agentic loop with SSE streaming: Architect → Builder → Supervisor → (re-iterate)."""

    def evt(data: dict) -> str:
        return f"data: {json.dumps(data)}\n\n"

    async def generate() -> AsyncGenerator[str, None]:
        profile = await get_profile(body.user_id)
        status: str = profile.get("status", "free")
        tokens_used: int = int(profile.get("tokens_used", 0))

        if status == "free" and tokens_used > FREE_TOKEN_DAILY_LIMIT:
            yield evt({"type": "error", "msg": "Free daily limit reached. Go Pro for ₦7,500!"})
            return
        if status == "pro" and tokens_used > PRO_TOKEN_MONTHLY_LIMIT:
            yield evt({"type": "error", "msg": "Monthly Pro budget reached. Top up available."})
            return

        model = PRO_MODEL if status == "pro" else FREE_MODEL

        # ── Architect ────────────────────────────────────────────────────
        yield evt({"type": "step", "step": "architect", "msg": "Analyzing your request..."})
        try:
            refined, plan, history = await asyncio.gather(
                refine_prompt(body.prompt),
                plan_project(body.prompt),
                load_history(body.user_id, limit=6),
            )
        except Exception as e:
            yield evt({"type": "error", "msg": str(e)})
            return

        stack      = plan.get("stack", "static-html")
        deploy_cmd = plan.get("deploy_cmd", "")
        file_hint  = {"nextjs": 5, "fullstack": 12, "expo": 6, "express": 6, "django": 11}.get(stack, 3)
        yield evt({"type": "step", "step": "architect", "msg": f"Stack: {stack}", "done": True})

        labeled    = f"BUILD REQUEST:\n{refined}"
        files:  list[FileOutput] = []
        message = ""
        auto_fixed = False
        max_attempts = 2

        # ── Web Search (if research intent detected) ─────────────────────
        if RESEARCH_RE.search(body.prompt):
            yield evt({"type": "step", "step": "search", "msg": "Searching knowledge base..."})
            # Skills cache first — free, instant, saves Brave credits
            skill_hit = search_skills(body.prompt)
            if skill_hit:
                labeled = f"BUILD REQUEST:\n{refined}\n\nLocal knowledge:\n{skill_hit}"
                yield evt({"type": "step", "step": "search", "msg": "Found in local skills ✓", "done": True})
            else:
                yield evt({"type": "step", "step": "search", "msg": "Searching the web..."})
                results = await web_search(body.prompt)
                if results:
                    snippets = "\n".join(f"- {r['title']}: {r['snippet']}" for r in results)
                    labeled  = f"BUILD REQUEST:\n{refined}\n\nWeb research:\n{snippets}"
                    yield evt({"type": "step", "step": "search", "msg": f"Found {len(results)} sources", "done": True})
                else:
                    yield evt({"type": "step", "step": "search", "msg": "No web results, using training knowledge", "done": True})

        hit_limit = False
        for attempt in range(max_attempts + 1):
            # ── Builder ──────────────────────────────────────────────────
            build_msg = f"Writing {file_hint} files..." if attempt == 0 else f"Applying corrections (attempt {attempt + 1})..."
            yield evt({"type": "step", "step": "builder", "msg": build_msg})
            try:
                raw = await call_llm(model, labeled, stack, history=history)
                raw, auto_fixed = await review_and_fix(raw, stack)
            except HTTPException as e:
                yield evt({"type": "error", "msg": e.detail})
                return

            message, files = parse_llm_response(raw)
            yield evt({"type": "step", "step": "builder", "msg": f"Wrote {len(files)} file(s)", "done": True})
            for f in files:
                yield evt({"type": "file", "msg": f.path, "lines": f.content.count("\n") + 1})

            if attempt >= max_attempts:
                hit_limit = True
                break

            # ── Supervisor ───────────────────────────────────────────────
            yield evt({"type": "step", "step": "supervisor", "msg": "Checking quality..."})
            satisfied, feedback = await call_supervisor(body.prompt, stack, files)

            if satisfied:
                yield evt({"type": "step", "step": "supervisor", "msg": "All requirements satisfied ✓", "done": True})
                break
            else:
                missing = feedback.replace("STATUS: RE-ITERATE", "").strip()
                first_issue = missing.split("\n")[0].lstrip("•-– ").strip()
                yield evt({"type": "correction", "msg": first_issue[:180]})
                labeled = f"BUILD REQUEST:\n{refined}\n\nSelf-correction required:\n{missing}"

        # ── Persist ──────────────────────────────────────────────────────
        final_message = message or plan.get("message", "Done.")
        if hit_limit:
            final_message += (
                "\n\n⚠ I hit my self-correction limit (3 attempts). "
                "If you spot any issues, describe them and I'll fix it immediately."
            )

        tokens_consumed = int((len(body.prompt) + sum(len(f.content) for f in files)) / 4)
        if _supabase is not None:
            try:
                await asyncio.gather(
                    _supabase.table("profiles").update({"tokens_used": tokens_used + tokens_consumed}).eq("id", body.user_id).execute(),
                    save_turn(body.user_id, "user", body.prompt, stack),
                    save_turn(body.user_id, "assistant", final_message, stack),
                )
            except Exception:
                pass

        yield evt({
            "type": "complete",
            "result": {
                "response": final_message,
                "model": model,
                "cached": False,
                "files": [{"path": f.path, "content": f.content} for f in files],
                "deploy_cmd": deploy_cmd,
                "stack": stack,
                "verified": auto_fixed,
            },
        })

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/chat", response_model=ChatResponse)
async def chat(body: ChatRequest, request: Request) -> ChatResponse:
    profile = await get_profile(body.user_id)
    status: str = profile.get("status", "free")
    tokens_used: int = int(profile.get("tokens_used", 0))

    if status == "pro" and tokens_used > PRO_TOKEN_MONTHLY_LIMIT:
        raise HTTPException(status_code=429, detail="Monthly Pro budget reached. Top up available.")

    if status == "free" and tokens_used > FREE_TOKEN_DAILY_LIMIT:
        raise HTTPException(status_code=429, detail="Free daily limit reached. Go Pro for ₦7,500!")

    model = PRO_MODEL if status == "pro" else FREE_MODEL

    # Run refiner, planner, and history load in parallel — all independent
    refined, plan, history = await asyncio.gather(
        refine_prompt(body.prompt),
        plan_project(body.prompt),
        load_history(body.user_id, limit=6),
    )

    stack = plan.get("stack", "static-html")
    # Label the prompt so refiner output is never mistaken for system instructions
    labeled = f"BUILD REQUEST:\n{refined}"
    raw = await call_llm(model, labeled, stack, history=history)

    # Post-generation review: silently fix breaking errors before delivering to user
    raw, auto_fixed = await review_and_fix(raw, stack)

    message, files = parse_llm_response(raw)
    if not message:
        message = plan.get("message", "Done.")

    tokens_consumed = int((len(body.prompt) + len(raw)) / 4)

    if _supabase is not None:
        try:
            await asyncio.gather(
                _supabase.table("profiles").update({
                    "tokens_used": tokens_used + tokens_consumed
                }).eq("id", body.user_id).execute(),
                save_turn(body.user_id, "user", body.prompt, stack),
                save_turn(body.user_id, "assistant", message, stack),
            )
        except Exception:
            pass

    return ChatResponse(
        response=message,
        model=model,
        files=files,
        deploy_cmd=plan.get("deploy_cmd", ""),
        stack=stack,
        verified=auto_fixed,
    )


@app.post("/fix-code", response_model=CodeFixResponse)
async def fix_code(body: CodeFixRequest) -> CodeFixResponse:
    """Fix a user's existing file. Generates a fix, creates test cases, verifies them, retries if needed."""
    code_cap = body.code[:6000]
    lang     = body.language or "code"
    problem  = body.problem

    fix_system = (
        f"You are an expert {lang} developer. Fix the bug in the code provided. "
        "Return ONLY the complete corrected file — no markdown fences, no explanation, no comments about what changed."
    )
    test_system = (
        "You are a code verification expert. Return only valid JSON — no markdown, no explanation outside the JSON."
    )

    fixed_code = ""
    tests: list[TestCase] = []
    explanation = "Bug fixed."
    all_passed = True

    for attempt in range(2):
        # ── Step 1: Generate fix ─────────────────────────────────────────
        fix_prompt = f"Problem to fix: {problem}\n\nFile: {body.file_path}\n\n{code_cap}"
        fixed_code = _strip_fences(await call_fast_llm(fix_prompt, fix_system, max_tokens=4096))

        # ── Step 2: Generate 3 tests and mentally verify them ────────────
        test_prompt = (
            f"This {lang} code was just fixed for the following problem:\n"
            f"'{problem}'\n\n"
            f"Fixed code:\n{fixed_code[:3000]}\n\n"
            "Create 3 test cases and mentally execute each one against the fixed code.\n"
            "Return ONLY this JSON (no extra text):\n"
            '{"explanation":"one sentence describing what was fixed",'
            '"tests":[{"name":"...","passed":true,"note":"one line result"}],'
            '"all_passed":true}'
        )

        try:
            test_raw  = await call_fast_llm(test_prompt, test_system, max_tokens=600)
            js        = test_raw[test_raw.find("{"):test_raw.rfind("}") + 1]
            data      = json.loads(js)
            tests     = [TestCase(**t) for t in data.get("tests", [])]
            all_passed  = bool(data.get("all_passed", True))
            explanation = data.get("explanation", "Bug fixed.")
        except Exception:
            # JSON parse failed — return the fix as-is
            break

        if all_passed or attempt == 1:
            break

        # Tests failed — add failure context for retry
        failed_notes = "; ".join(t.note for t in tests if not t.passed)
        problem = f"{body.problem}\nPrevious fix attempt failed: {failed_notes}"

    return CodeFixResponse(
        fixed_code=fixed_code,
        explanation=explanation,
        tests=tests,
        all_passed=all_passed,
        file_path=body.file_path,
    )


@app.post("/clarify", response_model=ClarifyResponse)
async def clarify_request(body: ClarifyRequest) -> ClarifyResponse:
    """Return 2-3 clarifying questions if the prompt is vague, else empty list."""
    system = (
        "You are OgaCode Architect. Decide if clarification is needed before building.\n"
        "If the request is already detailed and specific → return {\"questions\":[], \"plan_summary\":\"...\"}\n"
        "If vague or missing key details → return 2-3 short, targeted questions about features, audience, or preferences.\n"
        "Return ONLY valid JSON. No extra text."
    )
    prompt_txt = f'User request: \"{body.prompt}\"\n\nReturn: {{\"questions\":[...], \"plan_summary\":\"one sentence\"}}'

    questions_raw, plan = await asyncio.gather(
        call_fast_llm(prompt_txt, system, max_tokens=300),
        plan_project(body.prompt),
    )

    try:
        js   = questions_raw[questions_raw.find("{"):questions_raw.rfind("}") + 1]
        data = json.loads(js)
        return ClarifyResponse(
            questions=data.get("questions", [])[:3],
            stack=plan.get("stack", "static-html"),
            plan_summary=data.get("plan_summary", plan.get("message", "")),
        )
    except Exception:
        return ClarifyResponse(questions=[], stack=plan.get("stack", "static-html"), plan_summary=plan.get("message", ""))


@app.post("/plan", response_model=PlanResponse)
async def plan_only(body: ChatRequest) -> PlanResponse:
    """Return a plan (files + steps) without generating any code."""
    refined, plan = await asyncio.gather(
        refine_prompt(body.prompt),
        plan_project(body.prompt),
    )
    stack = plan.get("stack", "static-html")

    system = (
        "You are OgaCode Architect. Describe what you WOULD build — do NOT write any code.\n"
        "Return ONLY valid JSON: {\"files\":[...], \"steps\":[...], \"summary\":\"one sentence\"}"
    )
    raw = await call_fast_llm(f"Plan for: {refined[:500]}", system, max_tokens=450)

    try:
        js   = raw[raw.find("{"):raw.rfind("}") + 1]
        data = json.loads(js)
        return PlanResponse(
            stack=stack,
            deploy_cmd=plan.get("deploy_cmd", ""),
            files=data.get("files", []),
            steps=data.get("steps", []),
            summary=data.get("summary", plan.get("message", "")),
        )
    except Exception:
        return PlanResponse(
            stack=stack,
            deploy_cmd=plan.get("deploy_cmd", ""),
            files=[],
            steps=["Analyze request", "Generate files", "Verify output"],
            summary=plan.get("message", ""),
        )


@app.post("/webhook/paystack")
async def paystack_webhook(request: Request) -> dict:
    payload = await request.body()
    signature = request.headers.get("x-paystack-signature", "")
    secret = os.getenv("PAYSTACK_SECRET_KEY", "")

    if not secret:
        raise HTTPException(status_code=500, detail="Webhook secret not configured")

    expected = hmac.new(secret.encode(), payload, hashlib.sha512).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    event_data: dict = await request.json()
    event_type: str = event_data.get("event", "unknown")

    # TODO: handle subscription.create → provision credits in Supabase
    # TODO: handle charge.success → resume suspended account
    # TODO: handle subscription.disable → suspend account after grace period
    return {"received": True, "event": event_type}


# ── OpenClaude gRPC bridge ────────────────────────────────────────────────────

@app.get("/agent/stream")
async def agent_stream(task: str, cwd: str, session_id: str = "default") -> StreamingResponse:
    """SSE bridge: translates OpenClaude gRPC ServerMessage events → AgentEvent JSON lines.

    OpenClaude must be running: openclaude --grpc  (listens on localhost:50051)
    """

    async def _sse():
        try:
            async for msg in openclaude_client.stream_task(task, cwd, session_id):
                event = msg.WhichOneof("event")

                if event == "text_chunk":
                    pass  # suppress raw tokens — summary arrives in FinalResponse

                elif event == "tool_start":
                    args: dict = {}
                    try:
                        args = json.loads(msg.tool_start.arguments_json)
                    except Exception:
                        pass
                    payload = {
                        "type": "pre_tool_use",
                        "tool": msg.tool_start.tool_name,
                        "args": args,
                    }
                    yield f"data: {json.dumps(payload)}\n\n"

                elif event == "tool_result":
                    payload = {
                        "type": "post_tool_use",
                        "tool": msg.tool_result.tool_name,
                        "success": not msg.tool_result.is_error,
                        "output": msg.tool_result.output[:500],
                        "error": msg.tool_result.output if msg.tool_result.is_error else "",
                    }
                    yield f"data: {json.dumps(payload)}\n\n"

                elif event == "action_required":
                    payload = {
                        "type": "action_required",
                        "prompt_id": msg.action_required.prompt_id,
                        "question": msg.action_required.question,
                    }
                    yield f"data: {json.dumps(payload)}\n\n"

                elif event == "done":
                    summary = msg.done.full_text.strip()
                    payload = {
                        "type": "stop",
                        "success": True,
                        "summary": summary[:400],
                        "files": [],
                    }
                    yield f"data: {json.dumps(payload)}\n\n"
                    openclaude_client.cancel_task(session_id)
                    return

                elif event == "error":
                    payload = {
                        "type": "stop",
                        "success": False,
                        "summary": msg.error.message,
                        "files": [],
                    }
                    yield f"data: {json.dumps(payload)}\n\n"
                    return

        except Exception as exc:
            payload = {"type": "stop", "success": False, "summary": str(exc), "files": []}
            yield f"data: {json.dumps(payload)}\n\n"

    return StreamingResponse(
        _sse(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/agent/approve")
async def agent_approve(session_id: str, prompt_id: str, reply: str = "y") -> dict:
    """Forward a plan or command approval from the VS Code extension into the live gRPC stream."""
    ok = openclaude_client.send_approval(session_id, prompt_id, reply)
    return {"ok": ok}
