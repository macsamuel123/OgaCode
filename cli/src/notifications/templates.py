"""Template engine for notification messages.

Supports simple {{ variable }} substitution and basic conditionals.
"""

import re
from typing import Optional

from .models import NotificationProvider, Template


class TemplateEngine:
    """Renders notification templates with variable substitution."""

    VARIABLE_PATTERN = re.compile(r"\{\{\s*(\w+)\s*\}\}")
    CONDITIONAL_PATTERN = re.compile(
        r"\{\%\s*if\s+(\w+)\s*\%\}(.*?)\{\%\s*endif\s*\%\}",
        re.DOTALL,
    )

    def __init__(self) -> None:
        self._templates: dict[str, Template] = {}

    def register(self, template: Template) -> None:
        """Register a template."""
        self._templates[template.name] = template

    def register_many(self, templates: list[Template]) -> None:
        """Register multiple templates."""
        for t in templates:
            self.register(t)

    def get(self, name: str) -> Optional[Template]:
        """Get a template by name."""
        return self._templates.get(name)

    def list_templates(self) -> list[Template]:
        """List all registered templates."""
        return list(self._templates.values())

    def remove(self, name: str) -> bool:
        """Remove a template by name. Returns True if removed."""
        return self._templates.pop(name, None) is not None

    def render(
        self,
        template_name: str,
        variables: dict[str, str],
        provider: Optional[NotificationProvider] = None,
    ) -> tuple[str, str]:
        """Render a template with variables.

        Returns (subject, body) tuple.
        Raises KeyError if template not found.
        """
        template = self._templates.get(template_name)
        if template is None:
            raise KeyError(f"Template '{template_name}' not found")

        # Filter variables to only those defined in the template
        filtered_vars = {
            k: v for k, v in variables.items()
            if k in template.variables or k in self._extract_variables(template.subject_template + template.body_template)
        }

        subject = self._render_string(template.subject_template, filtered_vars)
        body = self._render_string(template.body_template, filtered_vars)

        return subject, body

    def _render_string(self, text: str, variables: dict[str, str]) -> str:
        """Render a single template string with variable substitution and conditionals."""

        # Process conditionals first
        def _replace_conditional(match: re.Match) -> str:
            var_name = match.group(1)
            content = match.group(2)
            if variables.get(var_name):
                return self._render_string(content, variables)
            return ""

        text = self.CONDITIONAL_PATTERN.sub(_replace_conditional, text)

        # Process variable substitution
        def _replace_var(match: re.Match) -> str:
            var_name = match.group(1)
            return variables.get(var_name, f"{{{{{var_name}}}}}")

        text = self.VARIABLE_PATTERN.sub(_replace_var, text)
        return text

    def _extract_variables(self, text: str) -> set[str]:
        """Extract variable names from a template string."""
        return set(self.VARIABLE_PATTERN.findall(text))

    def create_notification_from_template(
        self,
        template_name: str,
        recipient: str,
        variables: dict[str, str],
        **kwargs,
    ) -> tuple[str, str]:
        """Convenience method to render a template and return subject/body."""
        return self.render(template_name, variables)
