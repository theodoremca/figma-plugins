import { Script } from './types';

// ============================================================
// Claude Test — proof of concept: Figma plugin → local bridge
// server → Claude Code → response back to plugin.
//
// Requires:
//   - claude CLI installed and on PATH
//   - bridge server running: `node bridge/claude-bridge.js`
// ============================================================

const BRIDGE_URL = 'http://localhost:11437';

const claudeTest: Script = {
  id: 'claude-test',
  name: 'Claude Test (local)',
  description: 'Sends a prompt to your local Claude Code via the bridge server',
  async run() {
    // Build a tiny prompt based on what's selected (or just a hello)
    const selection = figma.currentPage.selection;
    let prompt: string;

    if (selection.length === 0) {
      prompt = 'Say hello in one short sentence and tell me what model you are.';
    } else {
      const first = selection[0];
      prompt = `I have a Figma node selected. Its name is "${first.name}" and its type is ${first.type}. In one short sentence, guess what kind of UI element this is and what it might do. No preamble, just the guess.`;
    }

    figma.notify('Calling local Claude Code…');
    figma.ui.postMessage({ type: 'ai-status', status: 'running' });
    const startTime = Date.now();

    try {
      const res = await fetch(`${BRIDGE_URL}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Bridge returned ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const response = data.response || '(empty response)';
      const durationMs = Date.now() - startTime;

      const output = {
        prompt,
        response,
        durationMs,
        bridgeUrl: BRIDGE_URL,
      };
      const jsonString = JSON.stringify(output, null, 2);

      figma.ui.postMessage({
        type: 'ai-status',
        status: 'done',
        usage: {
          provider: 'claude-local',
          model: 'claude (via bridge)',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          estimatedCostUSD: 0,
          durationMs,
        },
      });

      figma.ui.postMessage({
        type: 'json-output',
        json: jsonString,
        screenCount: 1,
        componentCount: 0,
        imageCount: 0,
      });

      figma.notify(`Claude replied in ${(durationMs / 1000).toFixed(1)}s`);
    } catch (err: any) {
      figma.ui.postMessage({ type: 'ai-status', status: 'failed' });
      const msg = err.message || String(err);
      figma.notify(
        msg.includes('Failed to fetch')
          ? `Bridge unreachable — is it running? (node bridge/claude-bridge.js)`
          : `Claude bridge error: ${msg}`,
        { timeout: 6000 }
      );
      console.error('Claude test failed:', err);
    }
  },
};

export default claudeTest;
