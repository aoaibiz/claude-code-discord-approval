#!/usr/bin/env python3
"""Claude Code PreToolUse Hook — Discord Approval Gate

Sends tool permission requests to a Discord bot's Approval API,
then polls for the user's decision (allow/deny) via file.

Setup:
  1. Set APPROVAL_API_URL environment variable (default: http://localhost:8766)
  2. Register this hook in Claude Code settings.json:
     {
       "hooks": {
         "PreToolUse": [{
           "hooks": [{
             "type": "command",
             "command": "python3 /path/to/discord_approval_hook.py",
             "timeout": 130000
           }]
         }]
       }
     }
"""

import json
import os
import sys
import time
import uuid
import urllib.request
import urllib.error

# Configuration
APPROVAL_DIR = os.environ.get("APPROVAL_DIR", "/tmp/claude_approvals")
POLL_INTERVAL = 2  # seconds
POLL_TIMEOUT = 120  # seconds
APPROVAL_API_URL = os.environ.get("APPROVAL_API_URL", "http://localhost:8766")
SOURCE_LABEL = os.environ.get("APPROVAL_SOURCE_LABEL", "Claude Code")

# Tools that skip approval (low-risk, read-only, or pre-approved)
SKIP_TOOLS = {
    "Read", "Glob", "Grep",
    "TodoRead", "TodoWrite",
    "TaskCreate", "TaskUpdate", "TaskGet", "TaskList",
    "ToolSearch", "Skill",
}

# Add your MCP tools that don't need approval
SKIP_PREFIXES = []  # e.g., ["mcp__plugin_discord_discord__"]


def should_skip(tool_name: str) -> bool:
    """Check if a tool should skip the approval flow."""
    if tool_name in SKIP_TOOLS:
        return True
    for prefix in SKIP_PREFIXES:
        if tool_name.startswith(prefix):
            return True
    return False


def send_approval_request(request_id: str, tool_name: str, tool_input: dict) -> bool:
    """Send approval request to the Discord bot's Approval API."""
    input_summary = ""
    if isinstance(tool_input, dict):
        for k, v in list(tool_input.items())[:3]:
            val_str = str(v)[:200]
            input_summary += f"{k}: {val_str}\n"

    payload = {
        "request_id": request_id,
        "tool_name": tool_name,
        "tool_input_summary": input_summary or "(no details)",
        "source": SOURCE_LABEL,
    }

    data = json.dumps(payload).encode("utf-8")
    url = f"{APPROVAL_API_URL}/send-approval-button"
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        return resp.status == 200
    except Exception:
        return False


def poll_for_decision(request_id: str) -> str:
    """Poll for approval decision file."""
    os.makedirs(APPROVAL_DIR, exist_ok=True)
    filepath = os.path.join(APPROVAL_DIR, f"{request_id}.json")

    start = time.time()
    while time.time() - start < POLL_TIMEOUT:
        if os.path.exists(filepath):
            try:
                with open(filepath, "r") as f:
                    data = json.load(f)
                os.remove(filepath)
                return data.get("decision", "deny")
            except Exception:
                return "deny"
        time.sleep(POLL_INTERVAL)

    return "timeout"


def main():
    try:
        input_data = json.load(sys.stdin)
    except Exception:
        print(json.dumps({}))
        sys.exit(0)

    tool_name = input_data.get("tool_name", "")

    if should_skip(tool_name):
        print(json.dumps({}))
        sys.exit(0)

    if not APPROVAL_API_URL:
        print(json.dumps({}))
        sys.exit(0)

    tool_input = input_data.get("tool_input", {})
    request_id = str(uuid.uuid4())[:8]

    sent = send_approval_request(request_id, tool_name, tool_input)
    if not sent:
        print(json.dumps({
            "systemMessage": "Warning: Could not reach Approval API. Allowing tool execution."
        }))
        sys.exit(0)

    decision = poll_for_decision(request_id)

    if decision in ("allow", "always"):
        result = {"hookSpecificOutput": {"permissionDecision": "allow"}}
        if decision == "always":
            result["systemMessage"] = f"'{tool_name}' added to always-allow list."
        print(json.dumps(result))
    elif decision == "timeout":
        print(json.dumps({
            "systemMessage": "Discord approval timed out (120s). Tool execution denied.",
            "hookSpecificOutput": {"permissionDecision": "deny"},
        }))
    else:
        print(json.dumps({
            "systemMessage": f"'{tool_name}' was denied via Discord.",
            "hookSpecificOutput": {"permissionDecision": "deny"},
        }))

    sys.exit(0)


if __name__ == "__main__":
    main()
