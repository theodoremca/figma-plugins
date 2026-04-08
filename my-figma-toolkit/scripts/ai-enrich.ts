// ============================================================
// AI Enrichment — Adds semantic context to exported screen JSON
// using Ollama (local) or Gemini (cloud).
//
// What it adds:
//   - summary: 1-2 sentence description of each screen
//   - semanticRole: on generically-named nodes (Frame 47 → "navigation-bar")
//   - flowDescription: how multiple screens connect
//   - sharedComponents: patterns that should be extracted as shared components
// ============================================================

export type AIProvider = 'ollama' | 'gemini';

export interface AISettings {
  enabled: boolean;
  provider: AIProvider;
  ollamaModel: string;
  ollamaUrl: string;
  geminiApiKey: string;
  geminiModel: string;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: false,
  provider: 'ollama',
  ollamaModel: 'qwen2.5-coder:14b',
  ollamaUrl: 'http://localhost:11434',
  geminiApiKey: '',
  geminiModel: 'gemini-2.0-flash',
};

export const AI_SETTINGS_KEY = 'screen-to-json-ai-settings';

interface AIEnrichment {
  screenSummaries: Record<string, string>;          // screenId → summary
  semanticRoles: Record<string, string>;            // nodeId → role
  flowDescription?: string;                          // multi-screen flow
  sharedComponents?: Array<{
    name: string;
    description: string;
    foundInScreens: string[];
  }>;
}

// ---- System Prompt ----

const SYSTEM_PROMPT = `You are a UI design analyzer. You receive a JSON representation of Figma screens and return structured analysis.

Your job is to add SEMANTIC CONTEXT that helps a code assistant (Claude Code) understand what things ARE, not just how they look.

Rules:
- Be concise. Summaries are 1-2 sentences max.
- Semantic roles should be lowercase-kebab-case (e.g., "navigation-bar", "search-input", "avatar-image", "call-to-action-button")
- Only tag nodes with generic names (Frame, Group, Rectangle, Vector, Ellipse, etc.). Skip nodes that already have meaningful names.
- For flow descriptions, describe the user journey in one short paragraph.
- Return ONLY valid JSON matching the exact schema below. No markdown, no explanation.

Response schema:
{
  "screenSummaries": { "<screen-id>": "<summary>" },
  "semanticRoles": { "<node-id>": "<role>" },
  "flowDescription": "<optional: multi-screen flow>",
  "sharedComponents": [{ "name": "<component-name>", "description": "<what-it-is>", "foundInScreens": ["<screen-name>"] }]
}`;

// ---- Build the user prompt from screen JSON ----

function buildUserPrompt(screensJson: any): string {
  // Send a trimmed version — strip children deeper than 2 levels to save tokens
  // but keep full top-level structure
  const trimmed = trimForAI(screensJson, 0, 3);

  return `Analyze these Figma screens and return the enrichment JSON:

${JSON.stringify(trimmed, null, 2)}`;
}

/** Recursively trim deep children to reduce token count */
function trimForAI(obj: any, depth: number, maxDepth: number): any {
  if (Array.isArray(obj)) {
    return obj.map(item => trimForAI(item, depth, maxDepth));
  }
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'children' && depth >= maxDepth) {
        // Replace deep children with a count hint
        const children = value as any[];
        if (children && children.length > 0) {
          result._childCount = children.length;
          result._childTypes = [...new Set(children.map((c: any) => c.type))];
        }
        continue;
      }
      // Skip large binary-like fields
      if (key === 'imageRef' || key === 'gradientTransform') continue;
      if (key === 'children') {
        result[key] = trimForAI(value, depth + 1, maxDepth);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  return obj;
}

// ---- Ollama Client ----

async function ollamaGenerate(prompt: string, settings: AISettings): Promise<string> {
  const url = `${settings.ollamaUrl}/api/generate`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.ollamaModel,
      prompt: prompt,
      system: SYSTEM_PROMPT,
      stream: false,
      format: 'json',
      options: {
        temperature: 0.3,
        num_ctx: 8192,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.response;
}

// ---- Gemini Client ----

async function geminiGenerate(prompt: string, settings: AISettings): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.geminiModel}:generateContent?key=${settings.geminiApiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: SYSTEM_PROMPT + '\n\n' + prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts?.[0]?.text) {
    throw new Error('No response from Gemini');
  }
  return candidate.content.parts[0].text;
}

// ---- Main Enrichment Function ----

export async function enrichScreenJSON(
  screenData: { screens: any[]; reusableComponents: any },
  settings: AISettings
): Promise<AIEnrichment | null> {
  try {
    const userPrompt = buildUserPrompt({
      screens: screenData.screens,
      reusableComponents: screenData.reusableComponents,
    });

    let rawResponse: string;

    if (settings.provider === 'ollama') {
      rawResponse = await ollamaGenerate(userPrompt, settings);
    } else {
      rawResponse = await geminiGenerate(userPrompt, settings);
    }

    // Parse the AI response
    const enrichment: AIEnrichment = JSON.parse(rawResponse);

    // Validate structure
    if (!enrichment.screenSummaries || typeof enrichment.screenSummaries !== 'object') {
      enrichment.screenSummaries = {};
    }
    if (!enrichment.semanticRoles || typeof enrichment.semanticRoles !== 'object') {
      enrichment.semanticRoles = {};
    }

    return enrichment;
  } catch (err: any) {
    console.error('AI enrichment failed:', err);
    figma.notify('AI enrichment failed: ' + (err.message || String(err)), { timeout: 5000 });
    return null;
  }
}

// ---- Apply Enrichment to JSON ----

export function applyEnrichment(screens: any[], enrichment: AIEnrichment): void {
  // Add summaries to top-level screens
  for (const screen of screens) {
    if (enrichment.screenSummaries[screen.id]) {
      screen.summary = enrichment.screenSummaries[screen.id];
    }
  }

  // Recursively add semantic roles
  function tagRoles(node: any): void {
    if (enrichment.semanticRoles[node.id]) {
      node.semanticRole = enrichment.semanticRoles[node.id];
    }
    if (node.children) {
      for (const child of node.children) {
        tagRoles(child);
      }
    }
  }

  for (const screen of screens) {
    tagRoles(screen);
  }
}

// ---- Fetch available Ollama models ----

export async function fetchOllamaModels(ollamaUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || []).map((m: any) => m.name);
  } catch {
    return [];
  }
}
