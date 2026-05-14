// ============================================================
// Import Design — node builders
//
// Pure builder functions: take a JSON node spec, return a Figma
// SceneNode. Styling, fills, fonts, vectors, auto-layout all
// handled here. Driven by spec/figma-json-spec.md.
// ============================================================

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ImportContext {
  tokens: {
    colors: Record<string, string>;
    textStyles: Record<string, any>;
  };
  // Map of component name -> ComponentNode (built before instances)
  components: Map<string, ComponentNode>;
  // Tracks fonts we've successfully loaded so we don't re-await
  loadedFonts: Set<string>;
}

// ---- Color parsing ----

export function parseColor(input: string | undefined, ctx: ImportContext): { color: RGB; opacity: number } | null {
  if (!input) return null;
  let s = String(input).trim();

  // Token reference
  if (ctx.tokens.colors[s]) s = ctx.tokens.colors[s];

  if (s === 'transparent' || s === 'none') return { color: { r: 0, g: 0, b: 0 }, opacity: 0 };

  // rgba(r, g, b, a)
  const rgba = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i);
  if (rgba) {
    return {
      color: { r: +rgba[1] / 255, g: +rgba[2] / 255, b: +rgba[3] / 255 },
      opacity: rgba[4] !== undefined ? parseFloat(rgba[4]) : 1,
    };
  }

  // Hex #RGB / #RRGGBB / #RRGGBBAA
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return { color: { r, g, b }, opacity: a };
    }
  }
  console.warn(`[import] Could not parse color: "${input}"`);
  return null;
}

// ---- Fill parsing (solid + gradients) ----

export function toFigmaFill(input: any, ctx: ImportContext): Paint | null {
  if (input == null) return null;

  // Solid color string
  if (typeof input === 'string') {
    const c = parseColor(input, ctx);
    if (!c) return null;
    return { type: 'SOLID', color: c.color, opacity: c.opacity };
  }

  // Gradient object
  if (typeof input === 'object' && input.type) {
    if (
      input.type === 'linear-gradient' ||
      input.type === 'radial-gradient' ||
      input.type === 'angular-gradient'
    ) {
      const stops: ColorStop[] = (input.stops || []).map((s: any) => {
        const c = parseColor(s.color, ctx) || { color: { r: 0, g: 0, b: 0 }, opacity: 1 };
        return {
          position: typeof s.position === 'number' ? s.position : 0,
          color: { r: c.color.r, g: c.color.g, b: c.color.b, a: c.opacity },
        };
      });
      const from = input.from || [0, 0];
      const to = input.to || [0, 1];
      // Build a simple linear gradient transform
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      // Figma's gradientTransform is an affine matrix [[a,b,c],[d,e,f]]
      // For a linear gradient from `from` to `to`:
      const gradientTransform: any = [
        [dx, dy, from[0]],
        [-dy, dx, from[1]],
      ];
      const typeMap: Record<string, string> = {
        'linear-gradient': 'GRADIENT_LINEAR',
        'radial-gradient': 'GRADIENT_RADIAL',
        'angular-gradient': 'GRADIENT_ANGULAR',
      };
      return {
        type: typeMap[input.type] as any,
        gradientStops: stops,
        gradientTransform,
      };
    }
  }

  return null;
}

// ---- Effects (shadows, blurs) ----

function parseShadowShorthand(input: string, ctx: ImportContext): Effect | null {
  // "x y blur color" or "x y blur spread color"
  // Color can be a hex/rgba (possibly with spaces inside)
  const trimmed = input.trim();
  // Pull out the color (rgba(...) or #...) from the end
  const colorMatch = trimmed.match(/(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|[a-zA-Z_][\w-]*)\s*$/);
  if (!colorMatch) return null;
  const colorStr = colorMatch[1];
  const numsStr = trimmed.slice(0, trimmed.length - colorStr.length).trim();
  const nums = numsStr.split(/\s+/).map(parseFloat).filter(n => !Number.isNaN(n));
  if (nums.length < 3) return null;

  const x = nums[0];
  const y = nums[1];
  const blur = nums[2];
  const spread = nums.length >= 4 ? nums[3] : 0;
  const c = parseColor(colorStr, ctx);
  if (!c) return null;

  return {
    type: 'DROP_SHADOW',
    color: { r: c.color.r, g: c.color.g, b: c.color.b, a: c.opacity },
    offset: { x, y },
    radius: blur,
    spread,
    blendMode: 'NORMAL',
    visible: true,
    showShadowBehindNode: false,
  } as Effect;
}

export function toFigmaEffects(spec: any, ctx: ImportContext): Effect[] {
  const effects: Effect[] = [];
  if (typeof spec.shadow === 'string') {
    const e = parseShadowShorthand(spec.shadow, ctx);
    if (e) effects.push(e);
  }
  if (Array.isArray(spec.effects)) {
    for (const eSpec of spec.effects) {
      if (eSpec.type === 'drop-shadow' || eSpec.type === 'inner-shadow') {
        const c = parseColor(eSpec.color, ctx) || { color: { r: 0, g: 0, b: 0 }, opacity: 0.1 };
        effects.push({
          type: eSpec.type === 'drop-shadow' ? 'DROP_SHADOW' : 'INNER_SHADOW',
          color: { r: c.color.r, g: c.color.g, b: c.color.b, a: c.opacity },
          offset: { x: eSpec.x || 0, y: eSpec.y || 0 },
          radius: eSpec.blur || 0,
          spread: eSpec.spread || 0,
          blendMode: 'NORMAL',
          visible: true,
          showShadowBehindNode: false,
        } as Effect);
      } else if (eSpec.type === 'layer-blur' || eSpec.type === 'background-blur') {
        effects.push({
          type: eSpec.type === 'layer-blur' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR',
          radius: eSpec.radius || 0,
          visible: true,
        } as Effect);
      }
    }
  }
  return effects;
}

// ---- Common style application ----

export function applyCommonStyles(node: any, spec: any, ctx: ImportContext): void {
  // Position
  if (spec.position && typeof node.x === 'number') {
    node.x = spec.position.x || 0;
    node.y = spec.position.y || 0;
  }

  // Size (skip for text auto-resize, vector handled separately)
  if (spec.size && typeof node.resize === 'function' && spec.type !== 'text' && spec.type !== 'line') {
    const w = Math.max(0.01, spec.size[0]);
    const h = Math.max(0.01, spec.size[1]);
    try { node.resize(w, h); } catch (e) { console.warn('resize failed', e); }
  }

  // Fill
  if ('fills' in node) {
    if (spec.fill !== undefined) {
      const fill = toFigmaFill(spec.fill, ctx);
      node.fills = fill ? [fill] : [];
    } else if (spec.background !== undefined) {
      // alias used by screens
      const fill = toFigmaFill(spec.background, ctx);
      node.fills = fill ? [fill] : [];
    }
  }

  // Stroke
  if (spec.stroke && 'strokes' in node) {
    const stroke = spec.stroke;
    const c = parseColor(stroke.color || stroke, ctx);
    if (c) {
      node.strokes = [{ type: 'SOLID', color: c.color, opacity: c.opacity }];
      if (typeof stroke.weight === 'number') node.strokeWeight = stroke.weight;
      if (stroke.align && 'strokeAlign' in node) node.strokeAlign = stroke.align;
      if (Array.isArray(stroke.dashes) && 'dashPattern' in node) node.dashPattern = stroke.dashes;
    }
  }

  // Corner radius
  if (spec.cornerRadius !== undefined && 'cornerRadius' in node) {
    if (Array.isArray(spec.cornerRadius)) {
      node.topLeftRadius = spec.cornerRadius[0] || 0;
      node.topRightRadius = spec.cornerRadius[1] || 0;
      node.bottomRightRadius = spec.cornerRadius[2] || 0;
      node.bottomLeftRadius = spec.cornerRadius[3] || 0;
    } else {
      node.cornerRadius = spec.cornerRadius;
    }
  }

  // Opacity
  if (typeof spec.opacity === 'number' && 'opacity' in node) node.opacity = spec.opacity;

  // Rotation
  if (typeof spec.rotation === 'number' && 'rotation' in node) node.rotation = spec.rotation;

  // Visibility
  if (spec.visible === false && 'visible' in node) node.visible = false;

  // Blend mode
  if (spec.blendMode && 'blendMode' in node) node.blendMode = spec.blendMode;

  // Effects
  if ('effects' in node) {
    const effects = toFigmaEffects(spec, ctx);
    if (effects.length > 0) node.effects = effects;
  }

  // Name
  if (spec.name && 'name' in node) node.name = spec.name;
}

// ---- Auto-layout ----

function parsePadding(p: any): [number, number, number, number] {
  // [top, right, bottom, left]
  if (typeof p === 'number') return [p, p, p, p];
  if (typeof p === 'string') {
    const nums = p.split(/\s+/).map(parseFloat).filter(n => !Number.isNaN(n));
    if (nums.length === 1) return [nums[0], nums[0], nums[0], nums[0]];
    if (nums.length === 2) return [nums[0], nums[1], nums[0], nums[1]];
    if (nums.length === 3) return [nums[0], nums[1], nums[2], nums[1]];
    if (nums.length === 4) return [nums[0], nums[1], nums[2], nums[3]];
  }
  return [0, 0, 0, 0];
}

export function applyAutoLayout(frame: FrameNode, autoLayout: any): void {
  if (!autoLayout) return;
  frame.layoutMode = autoLayout.direction === 'row' ? 'HORIZONTAL' : 'VERTICAL';
  if (typeof autoLayout.gap === 'number') frame.itemSpacing = autoLayout.gap;
  const [pt, pr, pb, pl] = parsePadding(autoLayout.padding);
  frame.paddingTop = pt;
  frame.paddingRight = pr;
  frame.paddingBottom = pb;
  frame.paddingLeft = pl;

  const alignMap: Record<string, any> = {
    start: 'MIN', center: 'CENTER', end: 'MAX', stretch: 'MIN',
  };
  const justifyMap: Record<string, any> = {
    start: 'MIN', center: 'CENTER', end: 'MAX', between: 'SPACE_BETWEEN',
  };
  if (autoLayout.alignItems) frame.counterAxisAlignItems = alignMap[autoLayout.alignItems] || 'MIN';
  if (autoLayout.justifyContent) frame.primaryAxisAlignItems = justifyMap[autoLayout.justifyContent] || 'MIN';
  if (autoLayout.wrap && 'layoutWrap' in frame) (frame as any).layoutWrap = 'WRAP';
}

// ---- Font loading ----

export async function ensureFontLoaded(family: string, style: string, ctx: ImportContext): Promise<FontName> {
  const key = `${family}::${style}`;
  const font: FontName = { family, style };
  if (ctx.loadedFonts.has(key)) return font;
  try {
    await figma.loadFontAsync(font);
    ctx.loadedFonts.add(key);
  } catch (err) {
    console.warn(`[import] Failed to load "${family} ${style}", falling back to Inter Regular:`, err);
    const fallback: FontName = { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(fallback);
    ctx.loadedFonts.add('Inter::Regular');
    return fallback;
  }
  return font;
}

export async function preloadAllFonts(json: any, ctx: ImportContext): Promise<void> {
  // Always load Inter Regular as fallback
  await ensureFontLoaded('Inter', 'Regular', ctx);

  const declared = json.tokens?.fonts || [];
  const promises: Promise<any>[] = [];
  for (const f of declared) {
    const styles = Array.isArray(f.styles) ? f.styles : ['Regular'];
    for (const s of styles) {
      promises.push(ensureFontLoaded(f.family, s, ctx));
    }
  }
  // Also walk text styles
  const ts = json.tokens?.textStyles || {};
  for (const name of Object.keys(ts)) {
    const t = ts[name];
    if (t.family) promises.push(ensureFontLoaded(t.family, t.style || 'Regular', ctx));
  }
  // Walk every text node in the tree to collect inline fonts too
  walkAndCollectFonts(json.screens || [], ctx, promises);
  walkAndCollectFonts((json.components || []).map((c: any) => c.node), ctx, promises);
  await Promise.all(promises);
}

function walkAndCollectFonts(nodes: any[], ctx: ImportContext, promises: Promise<any>[]): void {
  for (const n of nodes) {
    if (!n) continue;
    if (n.type === 'text' && n.textStyle && typeof n.textStyle === 'object' && n.textStyle.family) {
      promises.push(ensureFontLoaded(n.textStyle.family, n.textStyle.style || 'Regular', ctx));
    }
    if (n.children) walkAndCollectFonts(n.children, ctx, promises);
  }
}

// ---- Text builder ----

function resolveTextStyle(spec: any, ctx: ImportContext): any {
  if (typeof spec.textStyle === 'string') return ctx.tokens.textStyles[spec.textStyle] || {};
  if (spec.textStyle && typeof spec.textStyle === 'object') return spec.textStyle;
  return {};
}

export async function buildText(spec: any, ctx: ImportContext): Promise<TextNode> {
  const t = figma.createText();
  const style = resolveTextStyle(spec, ctx);
  const family = style.family || 'Inter';
  const styleName = style.style || 'Regular';
  const font = await ensureFontLoaded(family, styleName, ctx);
  t.fontName = font;

  const size = typeof style.size === 'number' ? style.size : 14;
  t.fontSize = size;

  t.characters = String(spec.text ?? '');

  if (spec.name) t.name = spec.name;

  // Color
  if (spec.color) {
    const c = parseColor(spec.color, ctx);
    if (c) t.fills = [{ type: 'SOLID', color: c.color, opacity: c.opacity }];
  } else if (style.color) {
    const c = parseColor(style.color, ctx);
    if (c) t.fills = [{ type: 'SOLID', color: c.color, opacity: c.opacity }];
  }

  // Line height
  if (style.lineHeight !== undefined) {
    if (style.lineHeight === 'AUTO') {
      t.lineHeight = { unit: 'AUTO' } as LineHeight;
    } else if (typeof style.lineHeight === 'number') {
      // Number = multiplier of font size. Convert to pixels.
      t.lineHeight = { unit: 'PIXELS', value: style.lineHeight * size } as LineHeight;
    } else if (typeof style.lineHeight === 'string') {
      const m = style.lineHeight.match(/^([\d.]+)(px|%)$/);
      if (m) {
        const v = parseFloat(m[1]);
        t.lineHeight = m[2] === 'px'
          ? { unit: 'PIXELS', value: v } as LineHeight
          : { unit: 'PERCENT', value: v } as LineHeight;
      }
    }
  }

  // Letter spacing
  if (style.letterSpacing !== undefined) {
    if (typeof style.letterSpacing === 'number') {
      t.letterSpacing = { unit: 'PIXELS', value: style.letterSpacing };
    } else if (typeof style.letterSpacing === 'string') {
      const m = style.letterSpacing.match(/^(-?[\d.]+)(px|%)$/);
      if (m) {
        t.letterSpacing = m[2] === 'px'
          ? { unit: 'PIXELS', value: parseFloat(m[1]) }
          : { unit: 'PERCENT', value: parseFloat(m[1]) };
      }
    }
  }

  if (style.textCase) t.textCase = style.textCase;
  if (style.textDecoration && style.textDecoration !== 'NONE') t.textDecoration = style.textDecoration;

  if (spec.align) {
    const map: Record<string, any> = { left: 'LEFT', center: 'CENTER', right: 'RIGHT', justify: 'JUSTIFIED' };
    t.textAlignHorizontal = map[spec.align] || 'LEFT';
  }
  if (spec.verticalAlign) {
    const map: Record<string, any> = { top: 'TOP', center: 'CENTER', bottom: 'BOTTOM' };
    t.textAlignVertical = map[spec.verticalAlign] || 'TOP';
  }

  // Auto-resize behavior — important for sizing
  if (spec.autoResize === 'NONE' && spec.size) {
    t.textAutoResize = 'NONE';
    t.resize(spec.size[0], spec.size[1]);
  } else if (spec.autoResize === 'HEIGHT' || (spec.size && !spec.autoResize)) {
    t.textAutoResize = 'HEIGHT';
    if (spec.size) t.resize(spec.size[0], t.height);
  } else {
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
  }

  // Position
  if (spec.position) {
    t.x = spec.position.x || 0;
    t.y = spec.position.y || 0;
  }

  return t;
}

// ---- Rectangle / Ellipse / Line ----

export function buildRectangle(spec: any, ctx: ImportContext): RectangleNode {
  const r = figma.createRectangle();
  applyCommonStyles(r, spec, ctx);
  return r;
}

export function buildEllipse(spec: any, ctx: ImportContext): EllipseNode {
  const e = figma.createEllipse();
  applyCommonStyles(e, spec, ctx);
  return e;
}

export function buildLine(spec: any, ctx: ImportContext): LineNode {
  const ln = figma.createLine();
  if (spec.size && Array.isArray(spec.size)) {
    ln.resize(Math.max(0.01, spec.size[0]), 0);
  }
  if (spec.stroke) {
    const c = parseColor(spec.stroke.color || spec.stroke, ctx);
    if (c) {
      ln.strokes = [{ type: 'SOLID', color: c.color, opacity: c.opacity }];
      if (typeof spec.stroke.weight === 'number') ln.strokeWeight = spec.stroke.weight;
      if (Array.isArray(spec.stroke.dashes)) ln.dashPattern = spec.stroke.dashes;
    }
  }
  if (spec.position) {
    ln.x = spec.position.x || 0;
    ln.y = spec.position.y || 0;
  }
  if (spec.rotation) ln.rotation = spec.rotation;
  if (spec.name) ln.name = spec.name;
  return ln;
}

// ---- Vector (SVG paths) ----

export function buildVector(spec: any, ctx: ImportContext): VectorNode | null {
  if (!spec.paths || spec.paths.length === 0) {
    console.warn('[import] vector has no paths');
    return null;
  }

  // Build an SVG string and use figma.createNodeFromSvg — handles strokes/fills natively
  const size = spec.size || [24, 24];
  const viewBox = spec.viewBox || [0, 0, size[0], size[1]];
  const svgPaths = spec.paths.map((p: any) => {
    const attrs: string[] = [`d="${p.d}"`];
    if (p.fill !== undefined) attrs.push(`fill="${p.fill}"`);
    if (p.stroke) attrs.push(`stroke="${p.stroke}"`);
    if (p.strokeWidth !== undefined) attrs.push(`stroke-width="${p.strokeWidth}"`);
    if (p.strokeLinecap) attrs.push(`stroke-linecap="${p.strokeLinecap}"`);
    if (p.strokeLinejoin) attrs.push(`stroke-linejoin="${p.strokeLinejoin}"`);
    return `<path ${attrs.join(' ')} />`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.join(' ')}" width="${size[0]}" height="${size[1]}">${svgPaths}</svg>`;

  let node: SceneNode;
  try {
    node = figma.createNodeFromSvg(svg);
  } catch (err) {
    console.warn('[import] createNodeFromSvg failed:', err);
    return null;
  }

  // createNodeFromSvg returns a FrameNode wrapping the vector(s); rename it
  if (spec.name) node.name = spec.name;
  if (spec.position) {
    node.x = spec.position.x || 0;
    node.y = spec.position.y || 0;
  }
  if (typeof spec.opacity === 'number') node.opacity = spec.opacity;
  if (typeof spec.rotation === 'number') node.rotation = spec.rotation;
  return node as any;
}
