# Claude Code Discord Approval Gate

> Approve or deny Claude Code tool permissions directly from Discord — no more switching to the terminal.

Claude Code asks for permission before running certain tools (Bash commands, file writes, web searches, etc.). Normally, you have to be watching the terminal to approve them. **This project sends those permission requests to Discord as interactive buttons**, so you can approve from your phone or any device.

## How it works

```
Claude Code tries to run a tool
        ↓
PreToolUse hook fires
        ↓
Hook sends request to Approval API server
        ↓
Discord bot posts message with 3 buttons:
  ✅ Allow Once  |  🔓 Always Allow  |  ❌ Deny
        ↓
You tap a button on Discord
        ↓
Decision is written to a file
        ↓
Hook reads the file → tool runs (or is blocked)
```

## Features

- **3 approval modes**: Allow once, Always allow, Deny
- **120-second timeout**: Auto-denies if no response (safety default)
- **Multi-machine support**: Works across machines via HTTP (e.g., Tailscale)
- **Configurable skip list**: Low-risk tools (Read, Glob, Grep) skip approval automatically
- **Button cleanup**: Buttons are removed after a decision is made
- **Ephemeral responses**: Only you see the confirmation message

## Components

| File | Description |
|------|-------------|
| `discord_approval_hook.py` | Claude Code PreToolUse hook — sends requests, polls for decisions |
| `approval_bot.js` | Discord bot with button handler + Approval API server (Express, port 8766) |
| `approval_server.py` | Lightweight HTTP server for receiving decisions (optional, for remote machines) |
| `.env.example` | Environment variable template |

## Quick Start

### 1. Install the Discord bot

```bash
git clone https://github.com/aoaibiz/claude-code-discord-approval.git
cd claude-code-discord-approval
npm install
cp .env.example .env
```

Edit `.env` with your Discord bot token and channel ID.

### 2. Set up the Claude Code hook

Copy the hook to your Claude Code hooks directory:

```bash
cp discord_approval_hook.py ~/.claude/hooks/
```

Add to your Claude Code `settings.json` (or `settings.local.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/hooks/discord_approval_hook.py",
            "timeout": 130000
          }
        ]
      }
    ]
  }
}
```

### 3. Start the bot

```bash
node approval_bot.js
```

### 4. Test it

Run Claude Code and trigger a tool that requires permission. You should see a button message appear in your Discord channel.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Your Discord bot token |
| `DISCORD_CHANNEL_ID` | Yes | Channel ID for approval messages |
| `DISCORD_ALLOWED_USER_ID` | Yes | Your Discord user ID (only you can approve) |
| `APPROVAL_API_PORT` | No | API server port (default: 8766) |
| `APPROVAL_DIR` | No | Directory for approval files (default: `/tmp/claude_approvals`) |
| `REMOTE_APPROVAL_HOST` | No | Remote machine IP for multi-machine setup |
| `REMOTE_APPROVAL_PORT` | No | Remote approval server port (default: 8765) |

## Multi-Machine Setup

If Claude Code runs on a different machine (e.g., a Mac laptop) and the Discord bot runs on a VPS:

1. Run `approval_server.py` on the Claude Code machine (listens on port 8765)
2. Set `REMOTE_APPROVAL_HOST` in the bot's `.env` to the Claude Code machine's IP
3. The bot will POST decisions to both local files AND the remote server

Works great with Tailscale for secure connectivity.

## Customizing the Skip List

Edit `SKIP_TOOLS` in `discord_approval_hook.py` to add tools that don't need approval:

```python
SKIP_TOOLS = {
    "Read", "Glob", "Grep",  # Always safe
    "mcp__plugin_discord_discord__reply",  # Your Discord MCP tools
    # Add more as needed
}
```

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐
│   Claude Code CLI   │     │    Discord Server     │
│                     │     │                       │
│  PreToolUse Hook ───┼─HTTP─▶ Approval API (:8766)│
│         │           │     │         │              │
│    Polls /tmp/      │     │  Posts button message  │
│    claude_approvals/│     │         │              │
│         ▲           │     │    User clicks button  │
│         │           │     │         │              │
│    Reads decision   │◀─HTTP─ Writes to /tmp/ or   │
│                     │     │  POSTs to remote       │
└─────────────────────┘     └──────────────────────┘
```

## Requirements

- Node.js 18+
- Python 3.8+
- discord.js v14
- A Discord bot with Message Content intent enabled

## License

MIT

## Credits

Built by the Talmud AI team.
