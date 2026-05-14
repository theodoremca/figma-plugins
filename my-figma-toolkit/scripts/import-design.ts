import { Script } from './types';
import {
  ImportContext,
  applyCommonStyles,
  applyAutoLayout,
  preloadAllFonts,
  buildText,
  buildRectangle,
  buildEllipse,
  buildLine,
  buildVector,
} from './import-design-builders';

// ============================================================
// Import Design from JSON — builds a Figma file from a JSON spec.
// See spec/figma-json-spec.md for the contract.
//
// User pastes JSON in the plugin UI, clicks Import.
// Plugin parses, preloads fonts, builds nodes, lays out screens
// left-to-right on the current page.
// ============================================================

const CLIENT_STORAGE_KEY = 'import-design-last-json';

/** Build a single node from a NodeSpec. Recurses into children. */
async function buildNode(spec: any, ctx: ImportContext): Promise<SceneNode | null> {
  if (!spec || !spec.type) return null;

  switch (spec.type) {
    case 'text':
      return await buildText(spec, ctx);

    case 'rectangle':
      return buildRectangle(spec, ctx);

    case 'ellipse':
      return buildEllipse(spec, ctx);

    case 'line':
      return buildLine(spec, ctx);

    case 'vector':
      return buildVector(spec, ctx);

    case 'frame': {
      const f = figma.createFrame();
      applyCommonStyles(f, spec, ctx);

      // Auto-layout BEFORE adding children (Figma needs it set early)
      if (spec.autoLayout) {
        applyAutoLayout(f, spec.autoLayout);
        // Enabling auto-layout resets sizingMode to AUTO (hug). If the spec
        // gave us an explicit size, pin both axes so the frame stays that size.
        if (spec.size) {
          f.primaryAxisSizingMode = 'FIXED';
          f.counterAxisSizingMode = 'FIXED';
          try { f.resize(spec.size[0], spec.size[1]); } catch { /* ignore */ }
        }
      }

      // Build and append children
      if (Array.isArray(spec.children)) {
        const stretch = spec.autoLayout && spec.autoLayout.alignItems === 'stretch';
        for (const childSpec of spec.children) {
          const child = await buildNode(childSpec, ctx);
          if (child) {
            f.appendChild(child);
            // "stretch" in CSS = child fills cross axis of auto-layout parent.
            // Figma expresses this via the child's layoutAlign = 'STRETCH'.
            if (stretch && 'layoutAlign' in child) {
              (child as any).layoutAlign = 'STRETCH';
            }
          }
        }
      }
      return f;
    }

    case 'group': {
      // Build children first, then group them (Figma's group requires nodes to exist)
      if (!Array.isArray(spec.children) || spec.children.length === 0) return null;
      const children: SceneNode[] = [];
      for (const childSpec of spec.children) {
        const child = await buildNode(childSpec, ctx);
        if (child) {
          figma.currentPage.appendChild(child); // group() needs nodes on the page first
          children.push(child);
        }
      }
      if (children.length === 0) return null;
      const g = figma.group(children, figma.currentPage);
      if (spec.name) g.name = spec.name;
      if (spec.position) {
        g.x = spec.position.x || 0;
        g.y = spec.position.y || 0;
      }
      if (typeof spec.opacity === 'number') g.opacity = spec.opacity;
      return g;
    }

    case 'instance': {
      const compName = spec.component;
      const comp = ctx.components.get(compName);
      if (!comp) {
        console.warn(`[import] unknown component "${compName}"`);
        return null;
      }
      const inst = comp.createInstance();
      if (spec.name) inst.name = spec.name;
      if (spec.position) {
        inst.x = spec.position.x || 0;
        inst.y = spec.position.y || 0;
      }
      return inst;
    }

    case 'image': {
      // Inline base64 → Figma image
      const r = figma.createRectangle();
      applyCommonStyles(r, spec, ctx);
      if (spec.image?.data) {
        try {
          const cleanB64 = spec.image.data.replace(/^data:image\/[^;]+;base64,/, '');
          const bytes = figma.base64Decode(cleanB64);
          const image = figma.createImage(bytes);
          const scaleMode = (spec.image.scaleMode || 'FILL').toUpperCase();
          r.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: scaleMode as any }];
        } catch (err) {
          console.warn('[import] failed to decode image:', err);
        }
      }
      return r;
    }

    default:
      console.warn(`[import] unknown node type: ${spec.type}`);
      return null;
  }
}

async function buildScreens(json: any, ctx: ImportContext): Promise<FrameNode[]> {
  const screens: FrameNode[] = [];
  let xOffset = 0;
  const gap = 100;

  for (const screenSpec of json.screens || []) {
    const frame = figma.createFrame();
    frame.name = screenSpec.name || 'Screen';
    const w = (screenSpec.size && screenSpec.size[0]) || 375;
    const h = (screenSpec.size && screenSpec.size[1]) || 812;
    frame.resize(w, h);
    frame.x = xOffset;
    frame.y = 0;
    frame.clipsContent = screenSpec.clipsContent !== false;

    // Apply background (frame fills)
    if (screenSpec.background) {
      // Reuse the common machinery by mapping background → fill
      applyCommonStyles(frame, { fill: screenSpec.background }, ctx);
    }

    if (screenSpec.autoLayout) {
      applyAutoLayout(frame, screenSpec.autoLayout);
      // Screens always have an explicit size — pin sizing modes so they don't hug.
      frame.primaryAxisSizingMode = 'FIXED';
      frame.counterAxisSizingMode = 'FIXED';
      try { frame.resize(w, h); } catch { /* ignore */ }
    }

    if (Array.isArray(screenSpec.children)) {
      const stretch = screenSpec.autoLayout && screenSpec.autoLayout.alignItems === 'stretch';
      for (const childSpec of screenSpec.children) {
        const child = await buildNode(childSpec, ctx);
        if (child) {
          frame.appendChild(child);
          if (stretch && 'layoutAlign' in child) {
            (child as any).layoutAlign = 'STRETCH';
          }
        }
      }
    }

    figma.currentPage.appendChild(frame);
    screens.push(frame);
    xOffset += w + gap;
  }
  return screens;
}

async function buildComponents(json: any, ctx: ImportContext): Promise<void> {
  if (!Array.isArray(json.components)) return;
  for (const comp of json.components) {
    const node = await buildNode(comp.node, ctx);
    if (!node) continue;
    // Wrap into a Figma component
    const component = figma.createComponent();
    component.name = comp.name;
    // Resize component to match node
    if ('width' in node && 'height' in node) {
      component.resize(node.width, node.height);
    }
    component.appendChild(node as any);
    ctx.components.set(comp.name, component);
    // Park components off-screen so they don't clutter the page
    component.x = -3000;
    component.y = -3000 + (ctx.components.size - 1) * 300;
  }
}

const importDesign: Script = {
  id: 'import-design',
  name: 'Import Design from JSON',
  description: 'Build a Figma design from a JSON spec (paste in next view)',
  hasConfig: true,
  async run(options?: { json?: string }) {
    const raw = (options && options.json) || '';
    if (!raw.trim()) {
      figma.notify('Paste your JSON in the Configure view first.');
      return;
    }

    let json: any;
    try {
      json = JSON.parse(raw);
    } catch (err: any) {
      figma.notify('Invalid JSON: ' + (err.message || err));
      return;
    }

    // Persist last input for convenience
    try {
      await figma.clientStorage.setAsync(CLIENT_STORAGE_KEY, raw.slice(0, 100000));
    } catch { /* ignore */ }

    const ctx: ImportContext = {
      tokens: {
        colors: (json.tokens && json.tokens.colors) || {},
        textStyles: (json.tokens && json.tokens.textStyles) || {},
      },
      components: new Map(),
      loadedFonts: new Set(),
    };

    figma.notify('Loading fonts…');
    await preloadAllFonts(json, ctx);

    figma.notify('Building components…');
    await buildComponents(json, ctx);

    figma.notify('Building screens…');
    const screens = await buildScreens(json, ctx);

    if (screens.length > 0) {
      figma.viewport.scrollAndZoomIntoView(screens);
      figma.currentPage.selection = screens;
    }

    figma.notify(`Imported ${screens.length} screen(s).`);

    // Build a small report for the UI
    const report = {
      imported: screens.length,
      screens: screens.map(s => ({ name: s.name, size: [s.width, s.height] })),
      components: Array.from(ctx.components.keys()),
      fontsLoaded: Array.from(ctx.loadedFonts),
    };
    figma.ui.postMessage({
      type: 'json-output',
      json: JSON.stringify(report, null, 2),
      screenCount: screens.length,
      componentCount: ctx.components.size,
      imageCount: 0,
    });
  },
};

// Expose the storage key so the UI can hydrate the last-used JSON if it wants
export { CLIENT_STORAGE_KEY as IMPORT_DESIGN_STORAGE_KEY };

export default importDesign;
