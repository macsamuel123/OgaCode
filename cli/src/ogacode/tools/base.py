from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolResult:
    success: bool
    output: str
    error: str = ""


class Tool:
    name: str
    description: str
    parameters: dict  # JSON Schema

    def execute(self, **kwargs: Any) -> ToolResult:
        raise NotImplementedError

    def estimate_data_cost(self, **kwargs: Any) -> int:
        """Estimated bytes this call adds to the LLM context."""
        return len(str(kwargs).encode())

    def to_openai_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }
