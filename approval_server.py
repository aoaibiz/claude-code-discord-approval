#!/usr/bin/env python3
"""Lightweight HTTP server for receiving approval decisions on remote machines.

Run this on the machine where Claude Code is running (if different from
the Discord bot machine). The Discord bot POSTs decisions here, and the
PreToolUse hook polls the resulting files.

Usage:
    python3 approval_server.py [--port 8765] [--dir /tmp/claude_approvals] [--secret YOUR_SECRET]

Security note:
    --secret is REQUIRED for production use. Without it, any process that can
    reach this port can forge approval decisions.
"""

import argparse
import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler


class ApprovalHandler(BaseHTTPRequestHandler):
    approval_dir = "/tmp/claude_approvals"
    secret = ""

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok", "service": "approval-server"})
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/approve":
            self._respond(404, {"error": "not found"})
            return

        # Secret check (required if configured)
        if self.secret:
            header_secret = self.headers.get("X-Approval-Secret", "")
            if header_secret != self.secret:
                self._respond(403, {"error": "invalid secret"})
                return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self._respond(400, {"error": "invalid JSON"})
            return

        request_id = data.get("request_id")
        decision = data.get("decision")

        if not request_id or not decision:
            self._respond(400, {"error": "request_id and decision required"})
            return

        # Validate request_id format (alphanumeric only, prevent path traversal)
        if not request_id.replace("-", "").isalnum() or len(request_id) > 64:
            self._respond(400, {"error": "invalid request_id format"})
            return

        # Validate decision value
        if decision not in ("allow", "always", "deny"):
            self._respond(400, {"error": "invalid decision value"})
            return

        # Write decision file with restrictive permissions
        os.makedirs(self.approval_dir, mode=0o700, exist_ok=True)
        filepath = os.path.join(self.approval_dir, f"{request_id}.json")
        fd = os.open(filepath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"decision": decision}, f)

        print(f"[Approval] {decision} for {request_id}")
        self._respond(200, {"status": "ok", "decision": decision})

    def _respond(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def log_message(self, format, *args):
        # Quieter logging
        pass


def main():
    parser = argparse.ArgumentParser(description="Approval decision receiver")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bind", default="127.0.0.1",
                        help="Bind address (default: 127.0.0.1 for local only)")
    parser.add_argument("--dir", default="/tmp/claude_approvals")
    parser.add_argument("--secret", default=os.environ.get("APPROVAL_SECRET", ""),
                        help="Shared secret for authenticating requests (recommended)")
    args = parser.parse_args()

    ApprovalHandler.approval_dir = args.dir
    ApprovalHandler.secret = args.secret

    if not args.secret:
        print("⚠️  WARNING: No --secret set. Any process on this network can forge approvals.")
        print("   Set --secret or APPROVAL_SECRET env var for production use.\n")

    server = HTTPServer((args.bind, args.port), ApprovalHandler)
    print(f"🔐 Approval server running on {args.bind}:{args.port}")
    print(f"📁 Writing decisions to {args.dir}")
    server.serve_forever()


if __name__ == "__main__":
    main()
