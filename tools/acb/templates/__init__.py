"""Jinja2 template loader for ACB prompts."""

from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader

_TEMPLATE_DIR = Path(__file__).resolve().parent

_env = Environment(
    loader=FileSystemLoader(str(_TEMPLATE_DIR)),
    keep_trailing_newline=True,
    trim_blocks=True,
    lstrip_blocks=True,
)


def render(name: str, **kwargs: object) -> str:
    """Render template *name* (e.g. ``"fix_prompt.j2"``) with *kwargs*."""
    tmpl = _env.get_template(name)
    return tmpl.render(**kwargs)
