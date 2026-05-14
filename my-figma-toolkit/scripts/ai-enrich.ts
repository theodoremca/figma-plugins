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
  geminiModel: 'gemini-2.5-flash',
};

export const AI_SETTINGS_KEY = 'screen-to-json-ai-settings';

export interface AIUsage {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUSD: number;
  durationMs: number;
}

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

interface AIRawResult {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// Cost per 1M tokens (input/output) — updated April 2026
const PRICING: Record<string, { input: number; output: number }> = {
  // Gemini
  'gemini-2.5-flash':       { input: 0.15,  output: 0.60 },
  'gemini-2.5-flash-lite':  { input: 0.05,  output: 0.20 },
  'gemini-2.5-pro':         { input: 1.25,  output: 5.00 },
  'gemini-2.0-flash':       { input: 0.10,  output: 0.40 },
  'gemini-2.0-flash-lite':  { input: 0.05,  output: 0.20 },
  'gemini-1.5-flash':       { input: 0.075, output: 0.30 },
  'gemini-1.5-pro':         { input: 1.25,  output: 5.00 },
  // Ollama (local = free)
  '_ollama_default':        { input: 0, output: 0 },
};

function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const price = PRICING[model] || PRICING['_ollama_default'];
  return (promptTokens / 1_000_000) * price.input + (completionTokens / 1_000_000) * price.output;
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

async function ollamaGenerate(prompt: string, settings: AISettings): Promise<AIRawResult> {
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
  return {
    text: data.response,
    usage: {
      promptTokens: data.prompt_eval_count || 0,
      completionTokens: data.eval_count || 0,
      totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
    },
  };
}

// ---- Gemini Client ----

async function geminiGenerate(prompt: string, settings: AISettings): Promise<AIRawResult> {
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

  // Extract JSON from response — Gemini may wrap it in markdown code fences
  let raw = candidate.content.parts[0].text.trim();
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    raw = jsonMatch[1].trim();
  }

  // Extract token usage from Gemini metadata
  const usage = data.usageMetadata || {};
  return {
    text: raw,
    usage: {
      promptTokens: usage.promptTokenCount || 0,
      completionTokens: usage.candidatesTokenCount || 0,
      totalTokens: usage.totalTokenCount || 0,
    },
  };
}

// ---- Main Enrichment Function ----

export interface EnrichmentResult {
  enrichment: AIEnrichment;
  usage: AIUsage;
}

export async function enrichScreenJSON(
  screenData: { screens: any[]; reusableComponents: any },
  settings: AISettings
): Promise<EnrichmentResult | null> {
  try {
    const startTime = Date.now();

    const userPrompt = buildUserPrompt({
      screens: screenData.screens,
      reusableComponents: screenData.reusableComponents,
    });

    let result: AIRawResult;

    if (settings.provider === 'ollama') {
      result = await ollamaGenerate(userPrompt, settings);
    } else {
      result = await geminiGenerate(userPrompt, settings);
    }

    const durationMs = Date.now() - startTime;
    const model = settings.provider === 'ollama' ? settings.ollamaModel : settings.geminiModel;

    // Parse the AI response
    const enrichment: AIEnrichment = JSON.parse(result.text);

    // Validate structure
    if (!enrichment.screenSummaries || typeof enrichment.screenSummaries !== 'object') {
      enrichment.screenSummaries = {};
    }
    if (!enrichment.semanticRoles || typeof enrichment.semanticRoles !== 'object') {
      enrichment.semanticRoles = {};
    }

    const usage: AIUsage = {
      provider: settings.provider,
      model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      estimatedCostUSD: estimateCost(model, result.usage.promptTokens, result.usage.completionTokens),
      durationMs,
    };

    return { enrichment, usage };
  } catch (err: any) {
    console.error('AI enrichment failed:', err);
    figma.notify('AI enrichment failed: ' + (err.message || String(err)), { timeout: 5000 });
    return null;
  }
}

// ---- Per-Screen Enrichment ----
// Analyze ONE screen at a time — shorter prompts, better accuracy, less context pressure

const SINGLE_SCREEN_SYSTEM_PROMPT = `You are a UI design analyzer. You receive ONE Figma screen and return structured analysis.

Rules:
- Be concise. Summary is 1-2 sentences.
- Semantic roles should be lowercase-kebab-case (e.g., "nav-bar", "search-input", "cta-button").
- Only tag nodes with generic names (Frame, Group, Rectangle, Vector, Ellipse). Skip nodes that already have meaningful names.
- Return ONLY valid JSON, no markdown.

Response schema:
{
  "summary": "what this screen does / its purpose",
  "screenType": "e.g. onboarding, home, detail, settings, profile, auth, list, form, modal",
  "keyElements": ["short descriptions of what's on screen"],
  "userActions": ["what a user can do here"],
  "semanticRoles": { "<node-id>": "<role>" }
}`;

export interface SingleScreenEnrichment {
  summary: string;
  screenType: string;
  keyElements: string[];
  userActions: string[];
  semanticRoles: Record<string, string>;
}

export interface SingleScreenResult {
  enrichment: SingleScreenEnrichment;
  usage: AIUsage;
}

async function callAI(prompt: string, systemPrompt: string, settings: AISettings): Promise<AIRawResult> {
  if (settings.provider === 'ollama') {
    const url = `${settings.ollamaUrl}/api/generate`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.ollamaModel,
        prompt,
        system: systemPrompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.3, num_ctx: 8192 },
      }),
    });
    if (!response.ok) throw new Error(`Ollama error ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return {
      text: data.response,
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
    };
  } else {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.geminiModel}:generateContent?key=${settings.geminiApiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: systemPrompt + '\n\n' + prompt }] }],
        generationConfig: { temperature: 0.3 },
      }),
    });
    if (!response.ok) throw new Error(`Gemini error ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts?.[0]?.text) throw new Error('No response from Gemini');
    let raw = candidate.content.parts[0].text.trim();
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) raw = jsonMatch[1].trim();
    const meta = data.usageMetadata || {};
    return {
      text: raw,
      usage: {
        promptTokens: meta.promptTokenCount || 0,
        completionTokens: meta.candidatesTokenCount || 0,
        totalTokens: meta.totalTokenCount || 0,
      },
    };
  }
}

/** Analyze a single screen — called once per screen in per-screen mode */
export async function enrichSingleScreen(
  screen: any,
  settings: AISettings
): Promise<SingleScreenResult | null> {
  try {
    const startTime = Date.now();
    const trimmed = trimForAI(screen, 0, 3);
    const prompt = `Analyze this Figma screen:\n\n${JSON.stringify(trimmed, null, 2)}`;

    const result = await callAI(prompt, SINGLE_SCREEN_SYSTEM_PROMPT, settings);
    const durationMs = Date.now() - startTime;
    const model = settings.provider === 'ollama' ? settings.ollamaModel : settings.geminiModel;

    const parsed = JSON.parse(result.text);
    const enrichment: SingleScreenEnrichment = {
      summary: parsed.summary || '',
      screenType: parsed.screenType || '',
      keyElements: Array.isArray(parsed.keyElements) ? parsed.keyElements : [],
      userActions: Array.isArray(parsed.userActions) ? parsed.userActions : [],
      semanticRoles: (parsed.semanticRoles && typeof parsed.semanticRoles === 'object') ? parsed.semanticRoles : {},
    };

    const usage: AIUsage = {
      provider: settings.provider,
      model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      estimatedCostUSD: estimateCost(model, result.usage.promptTokens, result.usage.completionTokens),
      durationMs,
    };
    return { enrichment, usage };
  } catch (err: any) {
    console.error('Single screen enrichment failed:', err);
    return null;
  }
}

// ---- Backend Spec Mode ----
// Analyze ONE screen and generate backend/API requirements (not visual details)

const BACKEND_SPEC_SYSTEM_PROMPT = `You are a senior backend architect. You receive a Figma screen JSON and generate a BACKEND SPECIFICATION for that screen.

Your job is to identify what a backend engineer needs to build to support this screen. IGNORE visual details like colors, fonts, spacing.

Focus on:
- INPUTS: form fields the user enters (email, password, search text, etc.)
- DATA REQUIREMENTS: what data the screen displays (entities, fields, relationships)
- API CALLS: endpoints needed (method, path, request body, response shape, error cases)
- USER ACTIONS: buttons/interactions that trigger API calls (submit, delete, save, share)
- STATE: what client-side state this screen likely needs (loading, error, success, validation)
- AUTH: does this screen require authentication? any role/permission needed?
- NAVIGATION: where does the user go after actions complete?

Rules:
- Infer from screen content, labels, UI patterns — make educated guesses for field types and endpoints
- Use REST conventions for endpoints (GET /resource, POST /resource, PUT /resource/:id, DELETE /resource/:id)
- Fields should include: name, type (string/number/boolean/array/object), validation if implied, required flag
- Be specific — "GET /products" not "get some data"
- If a screen is purely decorative (splash, onboarding illustrations), say so with minimal detail
- Return ONLY valid JSON, no markdown

Response schema:
{
  "screenName": "string",
  "purpose": "what this screen does from a data perspective",
  "requiresAuth": true/false,
  "inputs": [
    { "field": "name", "type": "string", "validation": "optional string", "required": true/false, "placeholder": "optional" }
  ],
  "dataRequirements": [
    {
      "entity": "User | Product | Post | ...",
      "fields": ["field1", "field2"],
      "source": "GET /endpoint",
      "pagination": "optional string hint",
      "filtering": ["optional filter fields"]
    }
  ],
  "apiCalls": [
    {
      "trigger": "what causes this call (screen load, button click, etc.)",
      "method": "GET/POST/PUT/DELETE/PATCH",
      "endpoint": "/path/:id",
      "requestBody": { "field": "type" },
      "responseBody": { "field": "type" },
      "errorCases": ["string descriptions"]
    }
  ],
  "userActions": [
    { "name": "button label", "triggers": "ref to apiCalls or navigation", "sideEffects": "optional" }
  ],
  "stateNeeded": ["loading", "error", "success", "validationErrors", "etc"],
  "navigationOnSuccess": "optional — where user goes after success",
  "inferredEntities": [
    { "name": "EntityName", "fields": [{ "name": "field", "type": "string" }] }
  ]
}`;

export interface BackendSpec {
  screenName: string;
  purpose: string;
  requiresAuth: boolean;
  inputs: Array<{ field: string; type: string; validation?: string; required: boolean; placeholder?: string }>;
  dataRequirements: Array<{ entity: string; fields: string[]; source?: string; pagination?: string; filtering?: string[] }>;
  apiCalls: Array<{ trigger: string; method: string; endpoint: string; requestBody?: any; responseBody?: any; errorCases?: string[] }>;
  userActions: Array<{ name: string; triggers?: string; sideEffects?: string }>;
  stateNeeded: string[];
  navigationOnSuccess?: string;
  inferredEntities: Array<{ name: string; fields: Array<{ name: string; type: string }> }>;
}

export interface BackendSpecResult {
  spec: BackendSpec;
  usage: AIUsage;
}

export async function generateBackendSpec(
  screen: any,
  settings: AISettings
): Promise<BackendSpecResult | null> {
  try {
    const startTime = Date.now();
    const trimmed = trimForAI(screen, 0, 3);
    const prompt = `Generate the backend specification for this screen:\n\n${JSON.stringify(trimmed, null, 2)}`;

    const result = await callAI(prompt, BACKEND_SPEC_SYSTEM_PROMPT, settings);
    const durationMs = Date.now() - startTime;
    const model = settings.provider === 'ollama' ? settings.ollamaModel : settings.geminiModel;

    const parsed = JSON.parse(result.text);
    const spec: BackendSpec = {
      screenName: parsed.screenName || screen.name || 'Unknown',
      purpose: parsed.purpose || '',
      requiresAuth: !!parsed.requiresAuth,
      inputs: Array.isArray(parsed.inputs) ? parsed.inputs : [],
      dataRequirements: Array.isArray(parsed.dataRequirements) ? parsed.dataRequirements : [],
      apiCalls: Array.isArray(parsed.apiCalls) ? parsed.apiCalls : [],
      userActions: Array.isArray(parsed.userActions) ? parsed.userActions : [],
      stateNeeded: Array.isArray(parsed.stateNeeded) ? parsed.stateNeeded : [],
      navigationOnSuccess: parsed.navigationOnSuccess,
      inferredEntities: Array.isArray(parsed.inferredEntities) ? parsed.inferredEntities : [],
    };

    const usage: AIUsage = {
      provider: settings.provider,
      model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      estimatedCostUSD: estimateCost(model, result.usage.promptTokens, result.usage.completionTokens),
      durationMs,
    };
    return { spec, usage };
  } catch (err: any) {
    console.error('Backend spec generation failed:', err);
    return null;
  }
}

// ---- Combine all backend specs into a project-level data model ----

const COMBINE_BACKEND_SYSTEM_PROMPT = `You are a senior backend architect. You receive backend specs from multiple screens and produce a consolidated data model and API plan for the whole project.

Rules:
- Merge duplicate entities across screens into a single canonical definition
- Build a unified list of API endpoints (dedupe where screens share endpoints)
- Identify likely authentication/authorization patterns
- List suggested database tables with fields and relationships
- Be concise but complete
- Return ONLY valid JSON, no markdown

Response schema:
{
  "summary": "short paragraph about what this backend needs to do",
  "authStrategy": "e.g. JWT, OAuth2, session-based + any role system",
  "dataModel": [
    {
      "name": "EntityName",
      "fields": [{ "name": "field", "type": "string/number/etc", "required": true, "unique": false, "notes": "optional" }],
      "relationships": [{ "to": "OtherEntity", "type": "one-to-many/many-to-many/etc", "via": "foreign key name" }]
    }
  ],
  "endpoints": [
    { "method": "GET", "path": "/resource", "purpose": "string", "authRequired": true, "usedByScreens": ["screen names"] }
  ],
  "thirdPartyIntegrations": [
    { "name": "e.g. Stripe, SendGrid, Firebase Auth", "purpose": "string", "inferredFromScreens": ["screen names"] }
  ],
  "notes": "anything worth flagging (missing screens, inconsistencies, assumptions made)"
}`;

export interface ProjectBackendPlan {
  summary: string;
  authStrategy: string;
  dataModel: Array<{
    name: string;
    fields: Array<{ name: string; type: string; required?: boolean; unique?: boolean; notes?: string }>;
    relationships?: Array<{ to: string; type: string; via?: string }>;
  }>;
  endpoints: Array<{ method: string; path: string; purpose: string; authRequired: boolean; usedByScreens: string[] }>;
  thirdPartyIntegrations: Array<{ name: string; purpose: string; inferredFromScreens: string[] }>;
  notes: string;
}

export interface ProjectBackendPlanResult {
  plan: ProjectBackendPlan;
  usage: AIUsage;
}

export async function combineBackendSpecs(
  specs: BackendSpec[],
  settings: AISettings
): Promise<ProjectBackendPlanResult | null> {
  if (specs.length === 0) return null;
  try {
    const startTime = Date.now();
    const prompt = `Consolidate these per-screen backend specs into a project-wide data model and API plan:\n\n${JSON.stringify(specs, null, 2)}`;
    const result = await callAI(prompt, COMBINE_BACKEND_SYSTEM_PROMPT, settings);
    const durationMs = Date.now() - startTime;
    const model = settings.provider === 'ollama' ? settings.ollamaModel : settings.geminiModel;

    const parsed = JSON.parse(result.text);
    const plan: ProjectBackendPlan = {
      summary: parsed.summary || '',
      authStrategy: parsed.authStrategy || '',
      dataModel: Array.isArray(parsed.dataModel) ? parsed.dataModel : [],
      endpoints: Array.isArray(parsed.endpoints) ? parsed.endpoints : [],
      thirdPartyIntegrations: Array.isArray(parsed.thirdPartyIntegrations) ? parsed.thirdPartyIntegrations : [],
      notes: parsed.notes || '',
    };

    const usage: AIUsage = {
      provider: settings.provider,
      model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      estimatedCostUSD: estimateCost(model, result.usage.promptTokens, result.usage.completionTokens),
      durationMs,
    };
    return { plan, usage };
  } catch (err: any) {
    console.error('Combine backend specs failed:', err);
    return null;
  }
}

/** Final flow analysis — combines all per-screen summaries into overall flow description */
const COMBINE_SYSTEM_PROMPT = `You are a UX analyst. You receive summaries of multiple screens and produce a final flow analysis.

Rules:
- flowDescription is a single paragraph describing the user journey.
- sharedComponents identifies UI patterns that appear across multiple screens.
- Return ONLY valid JSON, no markdown.

Response schema:
{
  "flowDescription": "single paragraph describing the overall user flow",
  "sharedComponents": [{ "name": "<component-name>", "description": "<what-it-is>", "foundInScreens": ["<screen-name>"] }]
}`;

export interface CombinedFlowResult {
  flowDescription: string;
  sharedComponents: Array<{ name: string; description: string; foundInScreens: string[] }>;
  usage: AIUsage;
}

export async function combineScreenSummaries(
  screenSummaries: Array<{ name: string; summary: string; screenType: string; keyElements: string[] }>,
  settings: AISettings
): Promise<CombinedFlowResult | null> {
  if (screenSummaries.length === 0) return null;
  try {
    const startTime = Date.now();
    const prompt = `Analyze this app's flow based on these screen summaries:\n\n${JSON.stringify(screenSummaries, null, 2)}`;

    const result = await callAI(prompt, COMBINE_SYSTEM_PROMPT, settings);
    const durationMs = Date.now() - startTime;
    const model = settings.provider === 'ollama' ? settings.ollamaModel : settings.geminiModel;

    const parsed = JSON.parse(result.text);
    const usage: AIUsage = {
      provider: settings.provider,
      model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      estimatedCostUSD: estimateCost(model, result.usage.promptTokens, result.usage.completionTokens),
      durationMs,
    };
    return {
      flowDescription: parsed.flowDescription || '',
      sharedComponents: Array.isArray(parsed.sharedComponents) ? parsed.sharedComponents : [],
      usage,
    };
  } catch (err: any) {
    console.error('Combine summaries failed:', err);
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

// ---- Fetch available Gemini models ----

export async function fetchGeminiModels(apiKey: string): Promise<string[]> {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    if (!response.ok) return [];
    const data = await response.json();
    return (data.models || [])
      .filter((m: any) =>
        (m.supportedGenerationMethods || []).includes('generateContent')
      )
      .map((m: any) => (m.name as string).replace('models/', ''))
      .sort();
  } catch {
    return [];
  }
}
