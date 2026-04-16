// Polyfill: JSZip uses setImmediate which doesn't exist in Figma's sandbox
if (typeof setImmediate === 'undefined') {
  (globalThis as any).setImmediate = (fn: Function, ...args: any[]) => setTimeout(fn, 0, ...args);
}

import { scripts } from './scripts';
import { AI_SETTINGS_KEY, DEFAULT_AI_SETTINGS, fetchOllamaModels, fetchGeminiModels } from './scripts/ai-enrich';
import type { AISettings } from './scripts/ai-enrich';

const BASE_PATH_KEY = 'screen-to-json-base-path';

figma.showUI(__html__, { width: 400, height: 640 });

// Send the script list + saved settings to the UI on launch
async function init() {
  const scriptList = scripts.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    hasConfig: s.hasConfig || false,
  }));
  figma.ui.postMessage({ type: 'script-list', scripts: scriptList });

  // Send saved base path
  const savedPath = await figma.clientStorage.getAsync(BASE_PATH_KEY) || '';
  figma.ui.postMessage({ type: 'base-path', path: savedPath });

  // Send saved AI settings
  const aiSettings: AISettings = await figma.clientStorage.getAsync(AI_SETTINGS_KEY) || DEFAULT_AI_SETTINGS;
  figma.ui.postMessage({ type: 'ai-settings', settings: aiSettings });
}
init();

// Handle messages from UI
figma.ui.onmessage = (msg: any) => {
  // Script execution — may include options
  if (msg.type === 'run-script' && msg.scriptId) {
    const script = scripts.find(s => s.id === msg.scriptId);
    if (script) {
      Promise.resolve(script.run(msg.options))
        .then(() => {
          figma.ui.postMessage({ type: 'done', scriptId: script.id });
        })
        .catch((err: any) => {
          figma.notify('Error: ' + (err.message || String(err)));
          figma.ui.postMessage({ type: 'error', message: err.message || String(err) });
        });
    }
  }

  // Save base path
  if (msg.type === 'save-base-path' && msg.path !== undefined) {
    figma.clientStorage.setAsync(BASE_PATH_KEY, msg.path).then(() => {
      figma.notify('Export path saved: ' + msg.path);
      figma.ui.postMessage({ type: 'base-path-saved', path: msg.path });
    });
  }

  // Save AI settings
  if (msg.type === 'save-ai-settings' && msg.settings) {
    figma.clientStorage.setAsync(AI_SETTINGS_KEY, msg.settings).then(() => {
      figma.notify('AI settings saved');
      figma.ui.postMessage({ type: 'ai-settings-saved', settings: msg.settings });
    });
  }

  // Fetch Ollama models
  if (msg.type === 'fetch-ollama-models') {
    const url = (msg as any).url || 'http://localhost:11434';
    fetchOllamaModels(url).then(models => {
      figma.ui.postMessage({ type: 'ollama-models', models });
    });
  }

  // Fetch Gemini models
  if (msg.type === 'fetch-gemini-models') {
    const apiKey = (msg as any).apiKey || '';
    fetchGeminiModels(apiKey).then(models => {
      figma.ui.postMessage({ type: 'gemini-models', models });
    });
  }
};
