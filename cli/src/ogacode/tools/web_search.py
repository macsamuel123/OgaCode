import re
from typing import Any

import httpx

from ogacode.tools.base import Tool, ToolResult

_DDG_URL = "https://html.duckduckgo.com/html/"
_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; OgaCode/0.1)", "Accept-Encoding": "gzip"}


def _strip_tags(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s).strip()


class WebSearchTool(Tool):
    name = "web_search"
    description = (
        "Search the web for docs, APIs, or code examples. "
        "Uses DuckDuckGo — no API key required."
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
            "max_results": {"type": "integer", "default": 4},
        },
        "required": ["query"],
    }

    def execute(self, query: str, max_results: int = 4, **_: Any) -> ToolResult:
        try:
            resp = httpx.post(_DDG_URL, data={"q": query}, headers=_HEADERS,
                              timeout=10, follow_redirects=True)
            titles   = re.findall(r'class="result__a"[^>]*>(.+?)</a>', resp.text)
            snippets = re.findall(r'class="result__snippet"[^>]*>(.+?)</a>', resp.text, re.DOTALL)

            lines = []
            for i, (t, s) in enumerate(zip(titles, snippets)):
                if i >= max_results:
                    break
                lines.append(f"{i + 1}. {_strip_tags(t)}\n   {_strip_tags(s)}")

            return ToolResult(success=True, output="\n\n".join(lines) or "No results found.")
        except httpx.TimeoutException:
            return ToolResult(success=False, output="", error="Search timed out.")
        except Exception as exc:
            return ToolResult(success=False, output="", error=str(exc))

    def estimate_data_cost(self, query: str = "", **_: Any) -> int:
        return len(query.encode()) + 800
