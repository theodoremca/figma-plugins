# Claude Bridge

Tiny local HTTP server so the Figma plugin can talk to your local Claude Code installation.

## Prerequisites

1. **Claude Code installed** and reachable on your PATH. Test with: `claude --version`
2. **Node.js** (any recent version — only uses built-ins, zero npm dependencies)

## Run

```bash
node bridge/claude-bridge.js
```

You should see:

```
Claude Bridge listening on http://localhost:11437
  POST /generate  { "prompt": "..." }
  GET  /health
```

Leave it running while you use the Figma plugin.

## Test it manually

```bash
# health check
curl http://localhost:11437/health

# send a prompt
curl -X POST http://localhost:11437/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Say hi in one word."}'
```

## Change the port

```bash
CLAUDE_BRIDGE_PORT=12000 node bridge/claude-bridge.js
```

If you change the port, update `manifest.json` `networkAccess.allowedDomains` and the URL in
`scripts/claude-test.ts` to match.

## Stop

Ctrl+C.
