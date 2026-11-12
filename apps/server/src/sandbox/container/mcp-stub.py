"""A stand-in for Harness's MCP server inside the sandbox.

The harness tools (fork_branches, ask_node) don't work in the sandbox: the container has no way to
reach Harness. A sandboxed Claude Code gets this stdio MCP server instead. It lists the very same
tool definitions (written by Harness to the JSON file it is given), so the model's prompt doesn't
change between the sandbox and outside (prompt cache), and answers every call with a note asking
the model to tell the user.

Usage: python3 mcp-stub.py <tools.json>
"""

import json
import sys

REFUSAL = (
    "Not available in sandbox mode: this conversation runs in a sandbox (a Docker container without "
    "access to Harness). Tell the user that this needs the sandbox turned off for this conversation "
    "(the lock button under the message box), and continue without it."
)


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def result_for(method, params, tools):
    """The result of a request, or None for a method this server doesn't have."""
    if method == "initialize":
        return {
            "protocolVersion": params.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {"listChanged": True}},
            "serverInfo": {"name": "harness", "version": "1.0.0"},
        }
    if method == "tools/list":
        return {"tools": tools}
    if method == "tools/call":
        return {"content": [{"type": "text", "text": REFUSAL}], "isError": True}
    if method == "ping":
        return {}
    return None


def main(tools_file):
    with open(tools_file, encoding="utf-8") as f:
        tools = json.load(f)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if not isinstance(request, dict) or request.get("id") is None:
            continue  # a notification: no answer
        result = result_for(request.get("method"), request.get("params") or {}, tools)
        if result is None:
            send({"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Method not found"}})
        else:
            send({"jsonrpc": "2.0", "id": request["id"], "result": result})


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: mcp-stub.py <tools.json>")
    main(sys.argv[1])
