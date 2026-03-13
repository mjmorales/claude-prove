# CAFI — Content-Addressable File Index

## Setup

Add the SessionStart hook to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "bash .prove/cafi/hook.sh"
      }
    ]
  }
}
```

## Usage

- **First time**: Run `/prove:index` to build the initial file index
- **Subsequent sessions**: The hook automatically checks for changes and updates descriptions
- **Force rebuild**: Run `/prove:index --force` to re-describe all files

## How It Works

1. At session start, the hook checks SHA256 hashes of all project files
2. Only new or changed files are sent to Claude for description
3. Descriptions are formatted as routing hints: "Read this file when [doing X]"
4. The full index is injected as context so Claude knows your codebase immediately
