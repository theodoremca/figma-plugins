import { scripts } from './scripts';

figma.showUI(__html__, { width: 400, height: 500 });

// Send the script list to the UI on launch
const scriptList = scripts.map(s => ({
  id: s.id,
  name: s.name,
  description: s.description,
}));

figma.ui.postMessage({ type: 'script-list', scripts: scriptList });

// Handle script execution
figma.ui.onmessage = (msg: { type: string; scriptId?: string }) => {
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
};
