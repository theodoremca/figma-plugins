import { Script } from './types';
import { AI_SETTINGS_KEY, DEFAULT_AI_SETTINGS } from './ai-enrich';
import type { AISettings, AIUsage } from './ai-enrich';

// ============================================================
// Project Blueprint — Scans all selected screens and generates
// a high-level product description: features, user flows, design
// tokens, screen inventory, user stories, and architecture.
//
// Purpose: Feed this to an AI coding assistant or AI design tool
// to recreate a similar product from scratch.
// ============================================================

// ---- Types ----

interface ColorToken {
  hex: string;
  rgba: { r: number; g: number; b: number; a: number };
  usageCount: number;
  usedOn: string[]; // node names where this color appears
}

interface FontToken {
  family: string;
  style: string; // "Bold", "Regular", "Semi Bold"
  sizes: number[];
  usageCount: number;
}

interface ScreenInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  childCount: number;
  hasTextInputs: boolean;
  hasButtons: boolean;
  hasImages: boolean;
  hasList: boolean;
  hasNavigation: boolean;
  componentInstances: string[]; // names of component instances used
  textContent: string[]; // all visible text (truncated)
}

interface ComponentInfo {
  id: string;
  name: string;
  usageCount: number;
  usedInScreens: string[];
}

interface DesignTokens {
  colors: ColorToken[];
  fonts: FontToken[];
  cornerRadii: number[];
  spacingValues: number[];
}

interface ProjectData {
  screenCount: number;
  screens: ScreenInfo[];
  components: ComponentInfo[];
  designTokens: DesignTokens;
  platformHint: string; // "mobile", "tablet", "desktop", "mixed"
}

// ---- Extraction Helpers ----

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const colorMap = new Map<string, ColorToken>();
const fontMap = new Map<string, FontToken>();
const cornerRadii = new Set<number>();
const spacingValues = new Set<number>();
const componentMap = new Map<string, ComponentInfo>();

function collectColors(node: SceneNode): void {
  if ('fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills)) {
    for (const fill of node.fills as Paint[]) {
      if (fill.type === 'SOLID' && fill.visible !== false) {
        const hex = rgbToHex(fill.color.r, fill.color.g, fill.color.b);
        const existing = colorMap.get(hex);
        if (existing) {
          existing.usageCount++;
          if (!existing.usedOn.includes(node.name) && existing.usedOn.length < 5) {
            existing.usedOn.push(node.name);
          }
        } else {
          colorMap.set(hex, {
            hex,
            rgba: {
              r: Math.round(fill.color.r * 255),
              g: Math.round(fill.color.g * 255),
              b: Math.round(fill.color.b * 255),
              a: fill.opacity ?? 1,
            },
            usageCount: 1,
            usedOn: [node.name],
          });
        }
      }
    }
  }
}

function collectFonts(node: SceneNode): void {
  if (node.type === 'TEXT') {
    const fontName = node.fontName;
    if (fontName !== figma.mixed) {
      const key = `${fontName.family}::${fontName.style}`;
      const existing = fontMap.get(key);
      const fontSize = node.fontSize !== figma.mixed ? node.fontSize as number : 0;
      if (existing) {
        existing.usageCount++;
        if (fontSize > 0 && !existing.sizes.includes(fontSize)) {
          existing.sizes.push(fontSize);
        }
      } else {
        fontMap.set(key, {
          family: fontName.family,
          style: fontName.style,
          sizes: fontSize > 0 ? [fontSize] : [],
          usageCount: 1,
        });
      }
    }
  }
}

function collectSpacing(node: SceneNode): void {
  if ('cornerRadius' in node && node.cornerRadius !== figma.mixed && node.cornerRadius > 0) {
    cornerRadii.add(node.cornerRadius);
  }
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    if (node.itemSpacing > 0) spacingValues.add(node.itemSpacing);
    if (node.paddingTop > 0) spacingValues.add(node.paddingTop);
    if (node.paddingRight > 0) spacingValues.add(node.paddingRight);
    if (node.paddingBottom > 0) spacingValues.add(node.paddingBottom);
    if (node.paddingLeft > 0) spacingValues.add(node.paddingLeft);
  }
}

function collectComponents(node: SceneNode, screenName: string): void {
  if (node.type === 'INSTANCE' && node.mainComponent) {
    const mc = node.mainComponent;
    const existing = componentMap.get(mc.id);
    if (existing) {
      existing.usageCount++;
      if (!existing.usedInScreens.includes(screenName)) {
        existing.usedInScreens.push(screenName);
      }
    } else {
      componentMap.set(mc.id, {
        id: mc.id,
        name: mc.name,
        usageCount: 1,
        usedInScreens: [screenName],
      });
    }
  }
}

function hasNodeType(node: SceneNode, check: (n: SceneNode) => boolean): boolean {
  if (check(node)) return true;
  if ('children' in node) {
    for (const child of (node as FrameNode).children) {
      if (hasNodeType(child, check)) return true;
    }
  }
  return false;
}

function collectTextContent(node: SceneNode, texts: string[]): void {
  if (node.type === 'TEXT' && node.characters.trim().length > 0) {
    const text = node.characters.trim().slice(0, 80);
    if (texts.length < 30) texts.push(text);
  }
  if ('children' in node) {
    for (const child of (node as FrameNode).children) {
      if (child.visible) collectTextContent(child, texts);
    }
  }
}

function traverseAll(node: SceneNode, screenName: string): void {
  collectColors(node);
  collectFonts(node);
  collectSpacing(node);
  collectComponents(node, screenName);

  if ('children' in node) {
    for (const child of (node as FrameNode).children) {
      if (child.visible) traverseAll(child, screenName);
    }
  }
}

function countChildren(node: SceneNode): number {
  let count = 0;
  if ('children' in node) {
    for (const child of (node as FrameNode).children) {
      if (child.visible) {
        count++;
        count += countChildren(child);
      }
    }
  }
  return count;
}

function guessPlatform(screens: ScreenInfo[]): string {
  if (screens.length === 0) return 'unknown';
  const widths = screens.map(s => s.width);
  const avg = widths.reduce((a, b) => a + b, 0) / widths.length;
  if (avg <= 430) return 'mobile';
  if (avg <= 850) return 'tablet';
  if (avg <= 1440) return 'desktop';
  return 'mixed';
}

// ---- AI Prompt Builder ----

function buildBlueprintPrompt(data: ProjectData): string {
  return `Analyze this Figma project and generate a comprehensive product blueprint.

## Project Data

**Platform:** ${data.platformHint}
**Total Screens:** ${data.screenCount}

### Screens:
${data.screens.map(s => `- "${s.name}" (${s.width}x${s.height}, ${s.childCount} elements)
  Inputs: ${s.hasTextInputs} | Buttons: ${s.hasButtons} | Images: ${s.hasImages} | Lists: ${s.hasList} | Nav: ${s.hasNavigation}
  Components: ${s.componentInstances.slice(0, 10).join(', ') || 'none'}
  Text: ${s.textContent.slice(0, 8).join(' | ') || 'none'}`).join('\n')}

### Reusable Components (${data.components.length}):
${data.components.slice(0, 30).map(c => `- "${c.name}" — used ${c.usageCount}x in: ${c.usedInScreens.join(', ')}`).join('\n')}

### Design Tokens:
**Colors (${data.designTokens.colors.length}):** ${data.designTokens.colors.slice(0, 15).map(c => `${c.hex} (${c.usageCount}x)`).join(', ')}
**Fonts:** ${data.designTokens.fonts.map(f => `${f.family} ${f.style} [${f.sizes.sort((a,b)=>a-b).join(', ')}px]`).join(', ')}
**Corner Radii:** ${Array.from(data.designTokens.cornerRadii).sort((a,b)=>a-b).join(', ')}px
**Spacing:** ${Array.from(data.designTokens.spacingValues).sort((a,b)=>a-b).join(', ')}px

---

Generate a JSON response with this exact structure:
{
  "projectName": "inferred name for this product",
  "projectDescription": "2-3 sentence overview of what this product does",
  "platform": "mobile/tablet/desktop/web",
  "category": "e.g. social media, e-commerce, fintech, productivity, health, etc.",
  "targetAudience": "who this product is for",
  "designStyle": "describe the visual design language (minimal, bold, corporate, playful, etc.)",
  "colorScheme": {
    "primary": "#hex",
    "secondary": "#hex",
    "accent": "#hex",
    "background": "#hex",
    "surface": "#hex",
    "textPrimary": "#hex",
    "textSecondary": "#hex",
    "error": "#hex",
    "success": "#hex"
  },
  "typography": {
    "headingFont": "font family",
    "bodyFont": "font family",
    "sizes": { "h1": 0, "h2": 0, "h3": 0, "body": 0, "caption": 0 }
  },
  "screens": [
    {
      "name": "screen name",
      "purpose": "what this screen does",
      "screenType": "e.g. onboarding, home, detail, settings, profile, auth, list, form, modal",
      "keyElements": ["element descriptions"],
      "userActions": ["what the user can do here"]
    }
  ],
  "userFlows": [
    {
      "name": "flow name (e.g. Onboarding, Purchase, Login)",
      "description": "what this flow accomplishes",
      "steps": ["Screen A → Screen B → Screen C"],
      "userStory": "As a [user], I want to [action] so that [benefit]"
    }
  ],
  "features": [
    {
      "name": "feature name",
      "description": "what it does",
      "relatedScreens": ["screen names"]
    }
  ],
  "navigation": {
    "pattern": "tab bar / drawer / stack / hybrid",
    "mainSections": ["section names"]
  },
  "reusablePatterns": [
    {
      "name": "pattern name (e.g. Card, ListItem, Header)",
      "description": "what it looks like and where it's used",
      "usageCount": 0
    }
  ],
  "technicalNotes": "any technical observations (API patterns, auth method, data structures implied by the UI)"
}`;
}

const BLUEPRINT_SYSTEM_PROMPT = `You are a senior product analyst and UI/UX expert. You analyze Figma design projects and produce comprehensive product blueprints.

Your output is used by AI coding assistants and AI design tools to recreate similar products from scratch. Be specific, detailed, and accurate.

Rules:
- Infer screen purposes from their names, text content, element types, and layout.
- Detect user flows by analyzing screen names and navigation patterns.
- Identify the color scheme by categorizing the most-used colors.
- Generate realistic user stories for each flow.
- Be specific about features — don't just list generic things.
- Return ONLY valid JSON, no markdown fences.`;

// ---- AI Call (reusing the same providers) ----

async function callAI(prompt: string, settings: AISettings): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  if (settings.provider === 'ollama') {
    const url = `${settings.ollamaUrl}/api/generate`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.ollamaModel,
        prompt: prompt,
        system: BLUEPRINT_SYSTEM_PROMPT,
        stream: false,
        format: 'json',
        options: { temperature: 0.3, num_ctx: 16384 },
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
        contents: [{ parts: [{ text: BLUEPRINT_SYSTEM_PROMPT + '\n\n' + prompt }] }],
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

// Cost estimation (same pricing as ai-enrich)
const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'gemini-2.5-flash-lite': { input: 0.05, output: 0.20 },
  'gemini-2.5-pro': { input: 1.25, output: 5.00 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-2.0-flash-lite': { input: 0.05, output: 0.20 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },
  '_default': { input: 0, output: 0 },
};

// ---- Main Script ----

const projectBlueprint: Script = {
  id: 'project-blueprint',
  name: 'Project Blueprint',
  description: 'Generate a full product spec from selected screens (features, flows, design tokens)',
  async run() {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.notify('Select all screens/frames of the project first.');
      return;
    }

    // Check AI settings
    const aiSettings: AISettings = await figma.clientStorage.getAsync(AI_SETTINGS_KEY) || DEFAULT_AI_SETTINGS;
    if (!aiSettings.enabled) {
      figma.notify('Enable AI in Settings first — this script requires AI to generate the blueprint.');
      figma.ui.postMessage({ type: 'show-settings' });
      return;
    }

    // Reset collection maps
    colorMap.clear();
    fontMap.clear();
    cornerRadii.clear();
    spacingValues.clear();
    componentMap.clear();

    figma.notify(`Scanning ${selection.length} screen(s)...`);

    // Phase 1: Collect data from all screens
    const screens: ScreenInfo[] = [];
    for (const node of selection) {
      const texts: string[] = [];
      collectTextContent(node, texts);
      traverseAll(node, node.name);

      const componentInstances: string[] = [];
      function findInstances(n: SceneNode) {
        if (n.type === 'INSTANCE') componentInstances.push(n.name);
        if ('children' in n) {
          for (const child of (n as FrameNode).children) {
            if (child.visible) findInstances(child);
          }
        }
      }
      findInstances(node);

      screens.push({
        id: node.id,
        name: node.name,
        width: Math.round(node.width),
        height: Math.round(node.height),
        childCount: countChildren(node),
        hasTextInputs: hasNodeType(node, n => n.name.toLowerCase().includes('input') || n.name.toLowerCase().includes('text field') || n.name.toLowerCase().includes('search')),
        hasButtons: hasNodeType(node, n => n.name.toLowerCase().includes('button') || n.name.toLowerCase().includes('btn') || n.name.toLowerCase().includes('cta')),
        hasImages: hasNodeType(node, n => {
          if ('fills' in n && n.fills !== figma.mixed && Array.isArray(n.fills)) {
            return (n.fills as Paint[]).some(f => f.type === 'IMAGE');
          }
          return false;
        }),
        hasList: hasNodeType(node, n => n.name.toLowerCase().includes('list') || n.name.toLowerCase().includes('scroll') || n.name.toLowerCase().includes('feed')),
        hasNavigation: hasNodeType(node, n => n.name.toLowerCase().includes('nav') || n.name.toLowerCase().includes('tab bar') || n.name.toLowerCase().includes('bottom bar') || n.name.toLowerCase().includes('header')),
        componentInstances: [...new Set(componentInstances)],
        textContent: texts,
      });
    }

    // Phase 2: Compile design tokens
    const sortedColors = Array.from(colorMap.values()).sort((a, b) => b.usageCount - a.usageCount);
    const sortedFonts = Array.from(fontMap.values()).sort((a, b) => b.usageCount - a.usageCount);

    const projectData: ProjectData = {
      screenCount: screens.length,
      screens,
      components: Array.from(componentMap.values()).sort((a, b) => b.usageCount - a.usageCount),
      designTokens: {
        colors: sortedColors,
        fonts: sortedFonts,
        cornerRadii: Array.from(cornerRadii).sort((a, b) => a - b),
        spacingValues: Array.from(spacingValues).sort((a, b) => a - b),
      },
      platformHint: guessPlatform(screens),
    };

    // Phase 3: Call AI
    figma.notify(`Generating blueprint with AI (${aiSettings.provider})...`);
    figma.ui.postMessage({ type: 'ai-status', status: 'running' });

    const startTime = Date.now();
    try {
      const prompt = buildBlueprintPrompt(projectData);
      const result = await callAI(prompt, aiSettings);
      const durationMs = Date.now() - startTime;
      const model = aiSettings.provider === 'ollama' ? aiSettings.ollamaModel : aiSettings.geminiModel;
      const price = PRICING[model] || PRICING['_default'];
      const cost = (result.usage.promptTokens / 1_000_000) * price.input + (result.usage.completionTokens / 1_000_000) * price.output;

      const usage: AIUsage = {
        provider: aiSettings.provider,
        model,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        estimatedCostUSD: cost,
        durationMs,
      };

      // Try to parse the AI response
      let blueprint: any;
      try {
        blueprint = JSON.parse(result.text);
      } catch {
        // AI might have returned non-JSON, wrap it
        blueprint = { rawResponse: result.text };
      }

      // Add metadata
      blueprint._meta = {
        generatedAt: new Date().toISOString(),
        screenCount: screens.length,
        componentCount: projectData.components.length,
        colorCount: sortedColors.length,
        fontCount: sortedFonts.length,
        platform: projectData.platformHint,
        aiUsage: usage,
      };

      // Add raw design tokens for reference
      blueprint.rawDesignTokens = {
        allColors: sortedColors.slice(0, 20),
        allFonts: sortedFonts,
        cornerRadii: projectData.designTokens.cornerRadii,
        spacing: projectData.designTokens.spacingValues,
      };

      const jsonString = JSON.stringify(blueprint, null, 2);

      figma.ui.postMessage({ type: 'ai-status', status: 'done', usage });

      figma.ui.postMessage({
        type: 'json-output',
        json: jsonString,
        screenCount: screens.length,
        componentCount: projectData.components.length,
        imageCount: 0,
      });

      figma.notify(`Blueprint generated! ${screens.length} screens analyzed.`);

    } catch (err: any) {
      figma.ui.postMessage({ type: 'ai-status', status: 'failed' });
      figma.notify('Blueprint generation failed: ' + (err.message || String(err)), { timeout: 5000 });
      console.error('Blueprint failed:', err);
    }
  },
};

export default projectBlueprint;
