"""Schema definitions for .claude/.prove.json and .claude/settings.json.

Schemas are plain Python dicts describing expected structure.
Each field spec is a dict with:
  - type: "str", "int", "bool", "list", "dict", "any"
  - required: bool (default False)
  - items: field spec for list items (optional)
  - fields: dict of field specs for dict values (optional)
  - values: field spec for arbitrary dict values (optional)
  - description: human-readable description
  - default: default value for migrations
"""

CURRENT_SCHEMA_VERSION = "3"

# --- .claude/.prove.json schema ---

PROVE_SCHEMA = {
    "version": CURRENT_SCHEMA_VERSION,
    "fields": {
        "schema_version": {
            "type": "str",
            "required": True,
            "description": "Schema version for migration tracking",
            "default": CURRENT_SCHEMA_VERSION,
        },
        "scopes": {
            "type": "dict",
            "required": False,
            "values": {"type": "str"},
            "description": "Maps commit scope names to directory paths",
        },
        "validators": {
            "type": "list",
            "required": False,
            "items": {
                "type": "dict",
                "fields": {
                    "name": {
                        "type": "str",
                        "required": True,
                        "description": "Human-readable validator name",
                    },
                    "command": {
                        "type": "str",
                        "required": False,
                        "description": "Shell command to execute",
                    },
                    "prompt": {
                        "type": "str",
                        "required": False,
                        "description": "Path to LLM validation prompt file",
                    },
                    "phase": {
                        "type": "str",
                        "required": True,
                        "description": "Execution phase: build, lint, test, custom, or llm",
                        "enum": ["build", "lint", "test", "custom", "llm"],
                    },
                },
            },
            "description": "Ordered list of validation checks",
        },
        "reporters": {
            "type": "list",
            "required": False,
            "items": {
                "type": "dict",
                "fields": {
                    "name": {
                        "type": "str",
                        "required": True,
                        "description": "Human-readable reporter name",
                    },
                    "command": {
                        "type": "str",
                        "required": True,
                        "description": "Shell command to execute",
                    },
                    "events": {
                        "type": "list",
                        "required": True,
                        "items": {"type": "str"},
                        "description": "Event types that trigger this reporter",
                    },
                },
            },
            "description": "Notification reporters for orchestrator events",
        },
        "claude_md": {
            "type": "dict",
            "required": False,
            "fields": {
                "references": {
                    "type": "list",
                    "required": False,
                    "items": {
                        "type": "dict",
                        "fields": {
                            "path": {
                                "type": "str",
                                "required": True,
                                "description": "File path for @ inclusion (supports ~ expansion)",
                            },
                            "label": {
                                "type": "str",
                                "required": True,
                                "description": "Human-readable label for this reference",
                            },
                        },
                    },
                    "description": "External files to include in CLAUDE.md via @ references",
                    "default": [],
                },
            },
            "description": "CLAUDE.md generation settings",
        },
        "tools": {
            "type": "dict",
            "required": False,
            "values": {
                "type": "dict",
                "fields": {
                    "enabled": {
                        "type": "bool",
                        "required": True,
                        "description": "Whether this tool is active in the project",
                        "default": True,
                    },
                    "config": {
                        "type": "dict",
                        "required": False,
                        "description": "Tool-specific configuration overrides",
                    },
                },
            },
            "description": "Tool activation state and configuration overrides",
        },
    },
}

# --- .claude/settings.json schema (prove-managed sections) ---

_HOOK_ENTRY_SCHEMA = {
    "type": "dict",
    "fields": {
        "type": {
            "type": "str",
            "required": True,
            "description": "Hook handler type",
            "enum": ["command", "http", "prompt", "agent"],
        },
        "command": {
            "type": "str",
            "required": False,
            "description": "Shell command for command-type hooks",
        },
        "async": {
            "type": "bool",
            "required": False,
            "description": "Run hook asynchronously",
            "default": False,
        },
        "timeout": {
            "type": "int",
            "required": False,
            "description": "Hook timeout in seconds",
            "default": 600,
        },
    },
}

_HOOK_MATCHER_SCHEMA = {
    "type": "dict",
    "fields": {
        "matcher": {
            "type": "str",
            "required": True,
            "description": "Regex pattern to match tool/agent names",
        },
        "hooks": {
            "type": "list",
            "required": True,
            "items": _HOOK_ENTRY_SCHEMA,
            "description": "Hook handlers to run on match",
        },
    },
}

SETTINGS_SCHEMA = {
    "version": CURRENT_SCHEMA_VERSION,
    "fields": {
        "hooks": {
            "type": "dict",
            "required": False,
            "values": {
                "type": "list",
                "items": _HOOK_MATCHER_SCHEMA,
            },
            "description": "Claude Code hook configuration keyed by event name",
        },
    },
}
