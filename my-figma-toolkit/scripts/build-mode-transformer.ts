// ============================================================
// Build Mode Transformer — converts raw Figma node JSON into a
// minimal, AI-ready "build" JSON:
//
//   - design tokens extracted to meta.tokens (colors + font)
//   - colors referenced by token name throughout
//   - semantic element types (status-bar, header, card, button, list, etc.)
//   - CSS-style shortcuts (padding "22 23", size [w,h])
//   - all Figma noise stripped (constraints, locked, blend modes, wrappers)
// ============================================================

export interface BuildTokens {
  colors: Record<string, string>; // tokenName → hex (#RRGGBB)
  font?: string;                   // single primary font family
}

export interface BuildMeta {
  exportedAt: string;
  mode: 'build';
  tokens: BuildTokens;
}

export interface BuildOutput {
  meta: BuildMeta;
  screens: any[];
}

// ---- Color utilities ----

function toHex(c: { r: number; g: number; b: number; a: number }): string {
  const r = c.r, g = c.g, b = c.b;
  const h = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

function toHexAlpha(c: { r: number; g: number; b: number; a: number }): string {
  if (c.a >= 0.995) return toHex(c);
  // Return with alpha as rgba if not fully opaque
  return `rgba(${c.r},${c.g},${c.b},${c.a.toFixed(2)})`;
}

/** RGB -> HSL conversion (0-255 in, 0-1 out for each) */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, l };
}

interface ColorUsage {
  hex: string;
  rgba: { r: number; g: number; b: number; a: number };
  count: number;
  onText: number;       // times this color appears on TEXT nodes
  onStroke: number;     // times used as stroke
  onBackground: number; // times used as a fill on a large rect / frame
}

// ---- Token naming heuristic ----

function nameColors(usages: ColorUsage[]): Record<string, string> {
  const tokens: Record<string, string> = {};
  const used = new Set<string>(); // hex values already assigned

  // Score each color along axes
  const scored = usages.map(u => {
    const { h, s, l } = rgbToHsl(u.rgba.r, u.rgba.g, u.rgba.b);
    return { ...u, h, s, l };
  });

  function assign(name: string, c: { hex: string }): void {
    if (used.has(c.hex) || tokens[name]) return;
    tokens[name] = c.hex;
    used.add(c.hex);
  }

  // Sort by count for "primary candidate" categories
  const byCount = [...scored].sort((a, b) => b.count - a.count);

  // --- Backgrounds (very light, near-white) ---
  const lights = byCount.filter(c => c.l >= 0.92 && c.s < 0.15);
  if (lights.length > 0) assign('bg', lights[0]);
  if (lights.length > 1) assign('surface', lights[1]);
  const surfaceMuteds = byCount.filter(c => c.l >= 0.85 && c.l < 0.95 && c.s < 0.15 && !used.has(c.hex));
  if (surfaceMuteds.length > 0) assign('surfaceMuted', surfaceMuteds[0]);

  // --- Dark ink (very dark) ---
  const darks = byCount.filter(c => c.l <= 0.12 && !used.has(c.hex));
  if (darks.length > 0) assign('ink', darks[0]);
  const pureDark = byCount.filter(c => c.l <= 0.03 && !used.has(c.hex));
  if (pureDark.length > 0) assign('dark', pureDark[0]);

  // --- Muted inks (medium gray) ---
  const mutedGrays = byCount.filter(c => c.l >= 0.35 && c.l <= 0.65 && c.s < 0.15 && !used.has(c.hex));
  if (mutedGrays.length > 0) assign('inkMuted', mutedGrays[0]);
  if (mutedGrays.length > 1) assign('inkLight', mutedGrays[1]);

  // --- Borders (light gray, often on strokes) ---
  const borders = byCount.filter(c => c.l >= 0.80 && c.l < 0.92 && c.s < 0.1 && !used.has(c.hex));
  if (borders.length > 0) assign('border', borders[0]);

  // --- On-dark / on-primary (pure white or near-white with high usage on text) ---
  const whites = byCount.filter(c => c.l >= 0.97 && !used.has(c.hex));
  if (whites.length > 0) assign('onPrimary', whites[0]);
  const offWhites = byCount.filter(c => c.l >= 0.92 && c.l < 0.98 && !used.has(c.hex));
  if (offWhites.length > 0) assign('onDark', offWhites[0]);

  // --- Semantic colors (saturated) ---
  const saturated = byCount.filter(c => c.s > 0.45 && c.l > 0.25 && c.l < 0.75 && !used.has(c.hex));

  // Primary = most-used saturated color
  if (saturated.length > 0) assign('primary', saturated[0]);

  // Greens
  const greens = saturated.filter(c => {
    const hDeg = c.h * 360;
    return hDeg >= 90 && hDeg <= 170 && !used.has(c.hex);
  });
  if (greens.length > 0) assign('positive', greens[0]);

  // Reds
  const reds = saturated.filter(c => {
    const hDeg = c.h * 360;
    return (hDeg <= 20 || hDeg >= 340) && !used.has(c.hex);
  });
  if (reds.length > 0) assign('negative', reds[0]);

  // Everything else gets a generic name
  let genericIdx = 1;
  for (const c of byCount) {
    if (used.has(c.hex)) continue;
    // Skip near-transparent
    if (c.rgba.a < 0.05) continue;
    assign(`color${genericIdx++}`, c);
  }

  return tokens;
}

// ---- Collect colors + fonts from all nodes ----

function collectTokenUsage(nodes: any[]): { colors: ColorUsage[]; font?: string } {
  const colorMap = new Map<string, ColorUsage>();
  const fontMap = new Map<string, number>();

  const considerColor = (rgba: { r: number; g: number; b: number; a: number } | undefined, ctx: 'text' | 'bg' | 'stroke') => {
    if (!rgba) return;
    const hex = toHex(rgba);
    const existing = colorMap.get(hex);
    if (existing) {
      existing.count++;
      if (ctx === 'text') existing.onText++;
      if (ctx === 'stroke') existing.onStroke++;
      if (ctx === 'bg') existing.onBackground++;
    } else {
      colorMap.set(hex, {
        hex,
        rgba,
        count: 1,
        onText: ctx === 'text' ? 1 : 0,
        onStroke: ctx === 'stroke' ? 1 : 0,
        onBackground: ctx === 'bg' ? 1 : 0,
      });
    }
  };

  function walk(n: any): void {
    const isText = n.type === 'TEXT';

    if (n.fills && Array.isArray(n.fills)) {
      for (const f of n.fills) {
        if (f.type === 'SOLID' && f.color) {
          considerColor(f.color, isText ? 'text' : 'bg');
        }
      }
    }
    if (n.strokes && Array.isArray(n.strokes)) {
      for (const s of n.strokes) {
        if (s.type === 'SOLID' && s.color) {
          considerColor(s.color, 'stroke');
        }
      }
    }
    if (isText && n.fontFamily) {
      fontMap.set(n.fontFamily, (fontMap.get(n.fontFamily) || 0) + 1);
    }
    if (n.children) {
      for (const child of n.children) walk(child);
    }
  }

  for (const n of nodes) walk(n);

  const colors = Array.from(colorMap.values());
  const font = fontMap.size > 0
    ? [...fontMap.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : undefined;

  return { colors, font };
}

// ---- Lookup: hex → token name ----

function buildHexToToken(tokens: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [name, hex] of Object.entries(tokens)) {
    m.set(hex.toUpperCase(), name);
  }
  return m;
}

function colorToToken(rgba: { r: number; g: number; b: number; a: number } | undefined, hexToToken: Map<string, string>): string | undefined {
  if (!rgba) return undefined;
  if (rgba.a < 0.995) {
    // Has transparency — keep raw
    return toHexAlpha(rgba);
  }
  const hex = toHex(rgba);
  return hexToToken.get(hex) || hex;
}

// ---- Padding / spacing shortcuts ----

function paddingShorthand(n: any): string | undefined {
  const t = n.paddingTop || 0;
  const r = n.paddingRight || 0;
  const b = n.paddingBottom || 0;
  const l = n.paddingLeft || 0;
  if (!t && !r && !b && !l) return undefined;
  if (t === r && r === b && b === l) return `${t}`;
  if (t === b && l === r) return `${t} ${l}`;
  return `${t} ${r} ${b} ${l}`;
}

// ---- Shadow shorthand (one effect only) ----

function shadowShorthand(effects: any[] | undefined): string | undefined {
  if (!effects || effects.length === 0) return undefined;
  const shadow = effects.find(e => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW');
  if (!shadow) return undefined;
  const x = shadow.offset?.x ?? 0;
  const y = shadow.offset?.y ?? 0;
  const blur = shadow.radius || 0;
  const c = shadow.color;
  const rgba = c ? `rgba(${c.r},${c.g},${c.b},${(c.a).toFixed(2)})` : 'rgba(0,0,0,0.1)';
  return `${x} ${y} ${blur} ${rgba}`;
}

// ---- First solid fill color ----

function firstFillColor(n: any, hexToToken: Map<string, string>): string | undefined {
  if (!n.fills || !Array.isArray(n.fills)) return undefined;
  for (const f of n.fills) {
    if (f.type === 'SOLID' && f.color) return colorToToken(f.color, hexToToken);
  }
  return undefined;
}

function firstStrokeColor(n: any, hexToToken: Map<string, string>): string | undefined {
  if (!n.strokes || !Array.isArray(n.strokes)) return undefined;
  for (const s of n.strokes) {
    if (s.type === 'SOLID' && s.color) return colorToToken(s.color, hexToToken);
  }
  return undefined;
}

// ---- Classification ----

function classifyBuildNode(n: any, parent?: any): string {
  const lower = (n.name || '').toLowerCase();

  if (n.type === 'TEXT') return 'text';

  if (/\bstatus\s*bar\b/.test(lower)) return 'status-bar';
  if (/\b(tab\s*bar|bottom\s*bar|bottom\s*nav)\b/.test(lower)) return 'bottom-nav';
  if (/\b(nav\s*bar|header|app\s*bar|top\s*bar)\b/.test(lower)) return 'header';
  if (/\b(input|field|textfield|text\s*field|textbox)\b/.test(lower)) return 'input';
  if (/\bsearch\b/.test(lower)) return 'search';
  if (/\b(button|btn|cta)\b/.test(lower)) return 'button';
  if (/\b(checkbox|radio|toggle|switch)\b/.test(lower)) return 'toggle';
  if (/\b(list|feed)\b/.test(lower)) return 'list';
  if (/\b(card|tile)\b/.test(lower)) return 'card';
  if (/\b(list\s*item|row|cell)\b/.test(lower)) return 'list-item';
  if (/\b(modal|dialog|sheet|popup|drawer)\b/.test(lower)) return 'modal';
  if (/\b(chip|tag|badge|pill)\b/.test(lower)) return 'chip';
  if (/\b(divider|separator)\b/.test(lower)) return 'divider';
  if (/\b(empty\s*state|empty)\b/.test(lower) && n.children && n.children.length >= 2) return 'empty-state';
  if (/\b(avatar|profile\s*pic|thumbnail)\b/.test(lower)) return 'avatar';
  if (/\b(section\s*header)\b/.test(lower)) return 'section-header';
  if (/\bicon\b/.test(lower)) return 'icon';

  // Image fill
  if (n.fills && n.fills.some((f: any) => f.type === 'IMAGE')) return 'image';

  // Vector shapes
  if (['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON'].includes(n.type)) return 'icon';
  if (n.type === 'ELLIPSE') {
    // Small ellipse = likely icon/dot; large = avatar/image
    if (n.width && n.width < 30) return 'icon';
    return 'avatar';
  }
  if (n.type === 'LINE') return 'divider';

  // Auto-detect repeated children = list
  if (n.children && n.children.length >= 3) {
    const firstType = n.children[0].type;
    const firstW = Math.round(n.children[0].width || 0);
    const firstH = Math.round(n.children[0].height || 0);
    const similar = n.children.filter((c: any) =>
      c.type === firstType
      && Math.abs((c.width || 0) - firstW) < 5
      && Math.abs((c.height || 0) - firstH) < 5
    );
    if (similar.length === n.children.length && similar.length >= 3) {
      return 'list';
    }
  }

  // Button-like: a frame with text + solid fill + rounded corners
  if (
    n.cornerRadius && n.cornerRadius > 0
    && n.fills && n.fills.some((f: any) => f.type === 'SOLID')
    && n.children && n.children.some((c: any) => c.type === 'TEXT')
  ) {
    // Only classify as button if it's relatively small/horizontal
    if (n.width && n.height && n.height < 100 && n.width < 400) {
      return 'button';
    }
  }

  // Component instance — prefix with component name
  if (n.isInstance && n.componentName) return 'component';

  return 'container';
}

// ---- Transform a single node ----

function transformNode(n: any, hexToToken: Map<string, string>, parent?: any, topLevelScreen?: boolean): any {
  const type = classifyBuildNode(n, parent);

  // TEXT node — short representation
  if (type === 'text') {
    const out: any = { type: 'text', text: n.characters || '' };
    const color = firstFillColor(n, hexToToken);
    if (color) out.color = color;
    if (n.fontSize && n.fontSize !== 'mixed') out.size = n.fontSize;
    if (n.fontWeight && !/regular/i.test(n.fontWeight)) out.weight = n.fontWeight;
    if (n.textAlignHorizontal && n.textAlignHorizontal !== 'LEFT') out.align = n.textAlignHorizontal.toLowerCase();
    return out;
  }

  // Divider — just note it
  if (type === 'divider') return { type: 'divider' };

  // Icon — just the name if available
  if (type === 'icon') {
    const out: any = { type: 'icon' };
    // Prefer library ref (e.g. "feather/bell") over PNG
    if (n.iconLibrary && n.iconName) {
      out.icon = `${n.iconLibrary}/${n.iconName}`;
    } else if (n.imageFile) {
      out.image = n.imageFile;
    } else {
      out.name = n.name;
    }
    const color = firstFillColor(n, hexToToken);
    if (color) out.color = color;
    return out;
  }

  // Build a general node
  const out: any = { type };

  // Name (only when it adds info vs the type)
  if (n.name && !/^(frame|group|rectangle|vector)\s*\d*$/i.test(n.name)) {
    out.name = n.name;
  }

  // Component ref
  if (n.isInstance && n.componentName) {
    out.component = n.componentName;
  }

  // Position (only for top-level screen children, since auto-layout positions most things)
  if (topLevelScreen) {
    if (typeof n.x === 'number' && n.x !== 0) out.x = Math.round(n.x);
    if (typeof n.y === 'number' && n.y !== 0) out.y = Math.round(n.y);
  }

  // Size — only include for things where it matters (not auto-layout intrinsics)
  if (typeof n.width === 'number' && typeof n.height === 'number') {
    // Skip size for text (auto-sized) and icons (handled via name)
    if (type !== 'text' && type !== 'icon') {
      out.width = Math.round(n.width);
      out.height = Math.round(n.height);
    }
  }

  // Background
  const bg = firstFillColor(n, hexToToken);
  if (bg) out.bg = bg;

  // Border / stroke
  const strokeColor = firstStrokeColor(n, hexToToken);
  if (strokeColor) out.border = strokeColor;

  // Corner radius
  if (n.cornerRadius && n.cornerRadius !== 'mixed' && n.cornerRadius > 0) {
    out.radius = n.cornerRadius;
  } else if (n.topLeftRadius || n.topRightRadius || n.bottomLeftRadius || n.bottomRightRadius) {
    const tl = n.topLeftRadius || 0, tr = n.topRightRadius || 0;
    const br = n.bottomRightRadius || 0, bl = n.bottomLeftRadius || 0;
    out.radius = `${tl} ${tr} ${br} ${bl}`;
  }

  // Padding
  const pad = paddingShorthand(n);
  if (pad) out.padding = pad;

  // Item spacing for auto-layout
  if (n.layoutMode && n.layoutMode !== 'NONE') {
    out.layout = n.layoutMode === 'HORIZONTAL' ? 'row' : 'col';
    if (n.itemSpacing) out.gap = n.itemSpacing;
  }

  // Shadow
  const shadow = shadowShorthand(n.effects);
  if (shadow) out.shadow = shadow;

  // Opacity
  if (typeof n.opacity === 'number' && n.opacity < 1) out.opacity = n.opacity;

  // Icon library reference (preferred over image export)
  if (n.iconLibrary && n.iconName) {
    out.icon = `${n.iconLibrary}/${n.iconName}`;
  } else if (n.imageFile) {
    // Image file reference (fallback)
    out.image = n.imageFile;
  }

  // Children
  if (n.children && n.children.length > 0) {
    const transformed = n.children
      .map((c: any) => transformNode(c, hexToToken, n, false))
      .filter((c: any) => c !== null);
    if (transformed.length > 0) out.children = transformed;
  }

  return out;
}

// ---- Transform a screen (top-level frame) ----

function transformScreen(n: any, hexToToken: Map<string, string>): any {
  const out: any = {
    name: n.name,
    size: [Math.round(n.width), Math.round(n.height)],
  };

  const bg = firstFillColor(n, hexToToken);
  if (bg) out.bg = bg;

  if (n.children && n.children.length > 0) {
    out.children = n.children
      .map((c: any) => transformNode(c, hexToToken, n, true))
      .filter((c: any) => c !== null);
  }

  return out;
}

// ---- Main entry point ----

export function buildModeTransform(screens: any[]): BuildOutput {
  // Phase 1: collect all colors + fonts
  const { colors, font } = collectTokenUsage(screens);

  // Phase 2: name the colors
  const colorTokens = nameColors(colors);
  const hexToToken = buildHexToToken(colorTokens);

  // Phase 3: transform each screen
  const transformedScreens = screens.map(s => transformScreen(s, hexToToken));

  return {
    meta: {
      exportedAt: new Date().toISOString(),
      mode: 'build',
      tokens: {
        colors: colorTokens,
        font,
      },
    },
    screens: transformedScreens,
  };
}
