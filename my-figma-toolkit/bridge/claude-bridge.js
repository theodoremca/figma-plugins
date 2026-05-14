#!/usr/bin/env node
// ============================================================
// Claude Bridge — tiny local HTTP server that lets the Figma
// plugin talk to your local Claude Code installation.
//
// Run with:   node claude-bridge.js
// Defaults:   listens on http://localhost:11437
//
// The Figma plugin POSTs { "prompt": "..." } to /generate
// and gets back { "response": "..." }.
// ============================================================

const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.CLAUDE_BRIDGE_PORT || 11437;

// Simple CORS — allow any origin (Figma plugin runs from origin "null")
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function jsonResponse(res, status, obj) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    // Use `claude -p` (print mode) — runs the prompt non-interactively and exits
    const child = spawn('claude', ['-p', prompt], {
      // Inherit env so Claude picks up ANTHROPIC_API_KEY if configured
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}. Is Claude Code installed and in your PATH?`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr || 'no stderr'}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    return jsonResponse(res, 200, { ok: true, service: 'claude-bridge', port: PORT });
  }

  // Generate endpoint
  if (req.method === 'POST' && req.url === '/generate') {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const prompt = (parsed.prompt || '').toString().trim();
        if (!prompt) {
          return jsonResponse(res, 400, { error: 'Missing "prompt"' });
        }

        console.log(`[bridge] prompt (${prompt.length} chars): ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}`);
        const t0 = Date.now();
        const response = await callClaude(prompt);
        const ms = Date.now() - t0;
        console.log(`[bridge] response in ${ms}ms (${response.length} chars)`);
        return jsonResponse(res, 200, { response, durationMs: ms });
      } catch (err) {
        console.error('[bridge] error:', err.message);
        return jsonResponse(res, 500, { error: err.message });
      }
    });
    return;
  }

  // Unknown route
  jsonResponse(res, 404, { error: 'Not found. Try POST /generate or GET /health' });
});

server.listen(PORT, () => {
  console.log(`Claude Bridge listening on http://localhost:${PORT}`);
  console.log(`  POST /generate  { "prompt": "..." }`);
  console.log(`  GET  /health`);
  console.log(`Press Ctrl+C to stop.`);
});
