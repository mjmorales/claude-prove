#!/usr/bin/env bash
# sync.sh — Symlink plugin skills, agents, and commands into ~/.claude/
#
# Usage:
#   ./sync.sh          # Install (create symlinks)
#   ./sync.sh install   # Same as above
#   ./sync.sh uninstall # Remove symlinks created by this script
#   ./sync.sh status    # Show what's linked and what's not
#
# What it does:
#   - Symlinks skills/  dirs   into ~/.claude/skills/
#   - Symlinks agents/*.md     into ~/.claude/agents/
#   - Symlinks commands/*.md   into ~/.claude/commands/
#   - Backs up any existing non-symlink targets to ~/.claude/backups/
#   - Removes old ~/.claude items that this plugin replaces

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
BACKUP_DIR="$CLAUDE_DIR/backups/workflow-plugin-$(date +%Y%m%d-%H%M%S)"

# Items to sync: source_relative -> target_dir, target_name
# Skills: directory symlinks
SKILL_NAMES=(brainstorm task-planner plan-step orchestrator cleanup commit)

# Agents: file symlinks
AGENT_FILES=(principal-architect.md)

# Commands: file symlinks
COMMAND_FILES=(plan-task.md plan-step.md autopilot.md full-auto.md task-cleanup.md commit.md)

# Old items in ~/.claude that this plugin replaces (will be removed/backed up)
OLD_SKILLS=(task-planner-skill plan-step-skill autopilot full-auto)
OLD_COMMANDS=()  # commands are overwritten by symlinks, old files backed up automatically

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[sync]${NC} $*"; }
warn()  { echo -e "${YELLOW}[sync]${NC} $*"; }
err()   { echo -e "${RED}[sync]${NC} $*" >&2; }
info()  { echo -e "${CYAN}[sync]${NC} $*"; }

backup_if_exists() {
    local target="$1"
    if [[ -e "$target" && ! -L "$target" ]]; then
        mkdir -p "$BACKUP_DIR"
        local name
        name="$(basename "$target")"
        cp -r "$target" "$BACKUP_DIR/$name"
        warn "Backed up $target -> $BACKUP_DIR/$name"
        rm -rf "$target"
    elif [[ -L "$target" ]]; then
        rm "$target"
    fi
}

install() {
    log "Installing workflow plugin symlinks..."
    log "Plugin: $PLUGIN_DIR"
    log "Target: $CLAUDE_DIR"
    echo

    # Remove old items that this plugin replaces
    for old in "${OLD_SKILLS[@]}"; do
        if [[ -e "$CLAUDE_DIR/skills/$old" ]]; then
            backup_if_exists "$CLAUDE_DIR/skills/$old"
            log "Removed old skill: $old"
        fi
    done

    # Symlink skills
    mkdir -p "$CLAUDE_DIR/skills"
    for skill in "${SKILL_NAMES[@]}"; do
        local src="$PLUGIN_DIR/skills/$skill"
        local dst="$CLAUDE_DIR/skills/$skill"
        if [[ ! -d "$src" ]]; then
            err "Skill not found: $src"
            continue
        fi
        backup_if_exists "$dst"
        ln -s "$src" "$dst"
        log "Linked skill: $skill"
    done

    # Symlink agents
    mkdir -p "$CLAUDE_DIR/agents"
    for agent in "${AGENT_FILES[@]}"; do
        local src="$PLUGIN_DIR/agents/$agent"
        local dst="$CLAUDE_DIR/agents/$agent"
        if [[ ! -f "$src" ]]; then
            err "Agent not found: $src"
            continue
        fi
        backup_if_exists "$dst"
        ln -s "$src" "$dst"
        log "Linked agent: $agent"
    done

    # Symlink commands
    mkdir -p "$CLAUDE_DIR/commands"
    for cmd in "${COMMAND_FILES[@]}"; do
        local src="$PLUGIN_DIR/commands/$cmd"
        local dst="$CLAUDE_DIR/commands/$cmd"
        if [[ ! -f "$src" ]]; then
            err "Command not found: $src"
            continue
        fi
        backup_if_exists "$dst"
        ln -s "$src" "$dst"
        log "Linked command: $cmd"
    done

    echo
    log "Done! Restart Claude Code to pick up changes."
    echo
    info "Managed items:"
    info "  Skills:   ${SKILL_NAMES[*]}"
    info "  Agents:   ${AGENT_FILES[*]}"
    info "  Commands: ${COMMAND_FILES[*]}"
    if [[ -d "$BACKUP_DIR" ]]; then
        echo
        warn "Backups saved to: $BACKUP_DIR"
    fi
}

uninstall() {
    log "Removing workflow plugin symlinks..."

    for skill in "${SKILL_NAMES[@]}"; do
        local dst="$CLAUDE_DIR/skills/$skill"
        if [[ -L "$dst" ]]; then
            rm "$dst"
            log "Removed skill link: $skill"
        fi
    done

    for agent in "${AGENT_FILES[@]}"; do
        local dst="$CLAUDE_DIR/agents/$agent"
        if [[ -L "$dst" ]]; then
            rm "$dst"
            log "Removed agent link: $agent"
        fi
    done

    for cmd in "${COMMAND_FILES[@]}"; do
        local dst="$CLAUDE_DIR/commands/$cmd"
        if [[ -L "$dst" ]]; then
            rm "$dst"
            log "Removed command link: $cmd"
        fi
    done

    echo
    log "Done! Plugin symlinks removed."
    warn "Note: Backed-up originals are still in $CLAUDE_DIR/backups/ if you want to restore them."
}

status() {
    info "Workflow plugin sync status"
    info "Plugin: $PLUGIN_DIR"
    echo

    local ok=0 missing=0 stale=0

    echo "Skills:"
    for skill in "${SKILL_NAMES[@]}"; do
        local dst="$CLAUDE_DIR/skills/$skill"
        if [[ -L "$dst" ]]; then
            local target
            target="$(readlink "$dst")"
            if [[ "$target" == "$PLUGIN_DIR/skills/$skill" ]]; then
                echo -e "  ${GREEN}OK${NC}  $skill -> $target"
                ok=$((ok + 1))
            else
                echo -e "  ${YELLOW}STALE${NC} $skill -> $target (expected $PLUGIN_DIR/skills/$skill)"
                stale=$((stale + 1))
            fi
        elif [[ -d "$dst" ]]; then
            echo -e "  ${YELLOW}LOCAL${NC} $skill (not a symlink — run install to replace)"
            stale=$((stale + 1))
        else
            echo -e "  ${RED}MISSING${NC} $skill"
            missing=$((missing + 1))
        fi
    done

    echo
    echo "Agents:"
    for agent in "${AGENT_FILES[@]}"; do
        local dst="$CLAUDE_DIR/agents/$agent"
        if [[ -L "$dst" ]]; then
            echo -e "  ${GREEN}OK${NC}  $agent"
            ok=$((ok + 1))
        elif [[ -f "$dst" ]]; then
            echo -e "  ${YELLOW}LOCAL${NC} $agent (not a symlink)"
            stale=$((stale + 1))
        else
            echo -e "  ${RED}MISSING${NC} $agent"
            missing=$((missing + 1))
        fi
    done

    echo
    echo "Commands:"
    for cmd in "${COMMAND_FILES[@]}"; do
        local dst="$CLAUDE_DIR/commands/$cmd"
        if [[ -L "$dst" ]]; then
            echo -e "  ${GREEN}OK${NC}  $cmd"
            ok=$((ok + 1))
        elif [[ -f "$dst" ]]; then
            echo -e "  ${YELLOW}LOCAL${NC} $cmd (not a symlink)"
            stale=$((stale + 1))
        else
            echo -e "  ${RED}MISSING${NC} $cmd"
            missing=$((missing + 1))
        fi
    done

    echo
    echo "Old items (should be removed):"
    for old in "${OLD_SKILLS[@]}"; do
        if [[ -e "$CLAUDE_DIR/skills/$old" ]]; then
            echo -e "  ${YELLOW}EXISTS${NC} skills/$old (will be backed up on install)"
        fi
    done

    echo
    info "Summary: $ok linked, $missing missing, $stale need update"
}

ACTION="${1:-install}"

case "$ACTION" in
    install)   install ;;
    uninstall) uninstall ;;
    status)    status ;;
    *)
        echo "Usage: $0 [install|uninstall|status]"
        exit 1
        ;;
esac
