// Polyfill: JSZip uses setImmediate which doesn't exist in Figma's sandbox
if (typeof setImmediate === 'undefined') {
  (globalThis as any).setImmediate = (fn: Function, ...args: any[]) => setTimeout(fn, 0, ...args);
}

import { scripts } from './scripts';

const BASE_PATH_KEY = 'screen-to-json-base-path';

figma.showUI(__html__, { width: 400, height: 500 });

// Send the script list + saved base path to the UI on launch
async function init() {
  const scriptList = scripts.map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
  }));
  figma.ui.postMessage({ type: 'script-list', scripts: scriptList });

  // Send saved base path to UI
  const savedPath = await figma.clientStorage.getAsync(BASE_PATH_KEY) || '';
  figma.ui.postMessage({ type: 'base-path', path: savedPath });
}
init();

// Handle messages from UI
figma.ui.onmessage = (msg: { type: string; scriptId?: string; path?: string }) => {
  // Script execution
  if (msg.type === 'run-script' && msg.scriptId) {
    const script = scripts.find(s => s.id === msg.scriptId);
    if (script) {
      Promise.resolve(script.run())
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
};
