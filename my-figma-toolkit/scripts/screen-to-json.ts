import { Script, ScreenToJsonOptions, DEFAULT_SCREEN_TO_JSON_OPTIONS } from './types';
import JSZip from 'jszip';
import { enrichScreenJSON, enrichSingleScreen, combineScreenSummaries, applyEnrichment, AI_SETTINGS_KEY, DEFAULT_AI_SETTINGS } from './ai-enrich';
import type { AISettings, AIUsage } from './ai-enrich';
import { buildModeTransform } from './build-mode-transformer';

// ============================================================
// Screen to JSON — Extracts a detailed JSON blueprint from
// selected Figma frames/screens for AI-driven UI generation.
//
// Everything is bundled into a single ZIP file:
//   figma-export.zip
//     ├── screen.json          (the full JSON blueprint)
//     └── images/
//         ├── avatar-12-34.png
//         └── ...
//
// ONE save dialog. Unzip and you have everything.
// Images exported as PNG only at 1x scale.
// ============================================================

interface NodeJSON {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  locked: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;

  // Layout
  layoutMode?: string;
  layoutAlign?: string;
  layoutGrow?: number;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  itemSpacing?: number;
  counterAxisSpacing?: number;

  // Constraints
  constraints?: { horizontal: string; vertical: string };

  // Fills & Strokes
  fills?: SerializedPaint[];
  strokes?: SerializedPaint[];
  strokeWeight?: number | typeof figma.mixed;
  strokeAlign?: string;
  dashPattern?: number[];

  // Corner radius
  cornerRadius?: number | typeof figma.mixed;
  topLeftRadius?: number;
  topRightRadius?: number;
  bottomLeftRadius?: number;
  bottomRightRadius?: number;

  // Effects (shadows, blurs)
  effects?: SerializedEffect[];

  // Blend mode
  blendMode?: string;

  // Clip content
  clipsContent?: boolean;

  // Text-specific
  characters?: string;
  fontSize?: number | typeof figma.mixed;
  fontFamily?: string;
  fontWeight?: string;
  fontStyle?: string;
  lineHeight?: any;
  letterSpacing?: any;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textAutoResize?: string;
  textDecoration?: string;
  textCase?: string;
  paragraphSpacing?: number;

  // Image — paths relative to the ZIP root
  imageRef?: string;
  imageFile?: string;  // path to PNG

  // Icon from a recognized library (no image needed, AI can use icon package)
  iconLibrary?: string;  // e.g. "feather", "vuesax", "lucide", "material", "heroicons", "ionicons"
  iconName?: string;     // e.g. "bell", "home-2", "chevron-right"

  // Component info
  isComponent?: boolean;
  isInstance?: boolean;
  componentName?: string;
  componentId?: string;
  componentProperties?: Record<string, any>;

  // Vector / Boolean
  vectorPaths?: string;
  booleanOperation?: string;

  // AI enrichment (added post-hoc, per-screen mode)
  summary?: string;
  semanticRole?: string;
  screenType?: string;
  keyElements?: string[];
  userActions?: string[];

  // Children
  children?: NodeJSON[];
}

interface SerializedPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color?: { r: number; g: number; b: number; a: number };
  gradientStops?: Array<{ position: number; color: { r: number; g: number; b: number; a: number } }>;
  gradientTransform?: number[][];
  scaleMode?: string;
  imageRef?: string;
  imageFile?: string;  // path to PNG
}

interface SerializedEffect {
  type: string;
  visible: boolean;
  radius: number;
  color?: { r: number; g: number; b: number; a: number };
  offset?: { x: number; y: number };
  spread?: number;
  blendMode?: string;
}

interface ScreenJSON {
  exportedAt: string;
  figmaFileKey: string;
  exportPath: string;
  imageScale: number;
  imageFormats: string[];
  aiEnriched: boolean;
  flowDescription?: string;
  sharedComponents?: Array<{ name: string; description: string; foundInScreens: string[] }>;
  screens: NodeJSON[];
  reusableComponents: Record<string, { name: string; usageCount: number; firstInstanceId: string }>;
  exportedImages: string[];
}

interface ImageExportTask {
  nodeId: string;
  node: SceneNode;
  baseName: string;
}

// ---- Helpers ----

const IMAGE_SCALE = 1;
const IMAGES_FOLDER = 'images';
const CLIENT_STORAGE_KEY = 'screen-to-json-base-path';

/** Generate a timestamp string like 2026-04-08-104416 */
function generateTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function rgbaFromFigma(color: RGB | RGBA, opacity?: number): { r: number; g: number; b: number; a: number } {
  return {
    r: Math.round(color.r * 255),
    g: Math.round(color.g * 255),
    b: Math.round(color.b * 255),
    a: parseFloat((('a' in color ? color.a : 1) * (opacity ?? 1)).toFixed(2)),
  };
}

/** Create a filesystem-safe base name from a node name + short id suffix */
function safeFilename(name: string, nodeId: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const idSuffix = nodeId.replace(':', '-');
  return `${clean}-${idSuffix}`;
}

/** Known icon library prefixes Figma users commonly name icons with */
const KNOWN_ICON_LIBRARIES = new Set([
  'feather', 'feathericons',
  'vuesax', 'iconsax',
  'lucide',
  'material', 'material-symbols', 'material-icons', 'mui',
  'heroicons',
  'ionicons', 'ion',
  'fontawesome', 'fa', 'fa-solid', 'fa-regular', 'fa-brands',
  'phosphor',
  'tabler',
  'bootstrap', 'bi',
  'antd',
  'remix',
  'iconpark',
  'octicons',
  'ri',
]);

/**
 * Try detecting icon library from node name or any ancestor's name
 * (icons are often children of a parent frame named "feather/bell" etc.)
 */
function detectIconLibraryFromChain(names: string[]): { library: string; iconName: string } | null {
  for (const n of names) {
    const hit = detectIconLibrary(n);
    if (hit) return hit;
  }
  return null;
}

/** A node is "likely an icon" if small, or named with a known library prefix */
function isLikelyIcon(node: SceneNode, ancestorNames: string[]): boolean {
  // Library-named → definitely an icon
  if (detectIconLibraryFromChain([node.name, ...ancestorNames])) return true;
  // Small square-ish size → likely an icon
  const w = (node as any).width || 0;
  const h = (node as any).height || 0;
  if (w > 0 && w <= 48 && h > 0 && h <= 48 && Math.abs(w - h) < 8) return true;
  // Named "icon" → likely an icon
  if (/\bicon\b/i.test(node.name)) return true;
  return false;
}

/**
 * Detect if a node's name looks like an icon library reference
 * (e.g., "feather/bell", "vuesax/cards", "lucide/home-2", "icon/material/search")
 */
function detectIconLibrary(name: string): { library: string; iconName: string } | null {
  const normalized = name.trim().toLowerCase();

  // Common patterns: "lib/icon", "icon/lib/name", "Icon/lib/name"
  const parts = normalized.split(/[\/\\]/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  // Strip leading "icon" / "icons" prefix if present
  if (parts[0] === 'icon' || parts[0] === 'icons') parts.shift();
  if (parts.length < 2) return null;

  const first = parts[0];
  if (!KNOWN_ICON_LIBRARIES.has(first)) return null;

  // Rejoin the rest as the icon name (handles nested like "lucide/chevron/right")
  const iconName = parts.slice(1).join('/');
  if (!iconName) return null;

  // Normalize common aliases to canonical library names
  const libraryAlias: Record<string, string> = {
    'feathericons': 'feather',
    'iconsax': 'vuesax',
    'material-icons': 'material',
    'material-symbols': 'material',
    'mui': 'material',
    'ion': 'ionicons',
    'fa': 'fontawesome',
    'fa-solid': 'fontawesome',
    'fa-regular': 'fontawesome',
    'fa-brands': 'fontawesome',
    'bi': 'bootstrap',
    'ri': 'remix',
  };
  const library = libraryAlias[first] || first;

  return { library, iconName };
}

/** Path inside the ZIP for an image file */
function zipImagePath(baseName: string, ext: string): string {
  // At 1x scale, no suffix. At other scales, append @{scale}x (e.g., @2x)
  const scaleSuffix = IMAGE_SCALE === 1 ? '' : `@${IMAGE_SCALE}x`;
  return `${IMAGES_FOLDER}/${baseName}${scaleSuffix}.${ext}`;
}

function serializePaint(paint: Paint, _fileKey: string): SerializedPaint {
  const base: SerializedPaint = {
    type: paint.type,
    visible: paint.visible !== false,
    opacity: paint.opacity ?? 1,
    blendMode: paint.blendMode,
  };

  if (paint.type === 'SOLID') {
    base.color = rgbaFromFigma(paint.color, paint.opacity);
  }

  if (
    paint.type === 'GRADIENT_LINEAR' ||
    paint.type === 'GRADIENT_RADIAL' ||
    paint.type === 'GRADIENT_ANGULAR' ||
    paint.type === 'GRADIENT_DIAMOND'
  ) {
    base.gradientStops = paint.gradientStops.map(s => ({
      position: s.position,
      color: rgbaFromFigma(s.color),
    }));
    base.gradientTransform = paint.gradientTransform as any;
  }

  if (paint.type === 'IMAGE') {
    base.scaleMode = paint.scaleMode;
    if (paint.imageHash) {
      base.imageRef = paint.imageHash;
    }
  }

  return base;
}

function serializeEffect(effect: Effect): SerializedEffect {
  const e: SerializedEffect = {
    type: effect.type,
    visible: effect.visible !== false,
    radius: effect.radius,
  };

  if ('color' in effect && effect.color) {
    e.color = rgbaFromFigma(effect.color);
  }
  if ('offset' in effect && effect.offset) {
    e.offset = { x: effect.offset.x, y: effect.offset.y };
  }
  if ('spread' in effect) {
    e.spread = (effect as any).spread;
  }
  if (effect.blendMode) {
    e.blendMode = effect.blendMode;
  }

  return e;
}

function getFileKey(): string {
  try {
    return (figma as any).fileKey || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Track component usage for reusable component detection
const componentUsageMap = new Map<string, { name: string; count: number; firstInstanceId: string }>();

// Collect nodes that need image export
const imageExportTasks: ImageExportTask[] = [];
// Map from dedup-key (imageHash | mainComponent.id | nodeId) to the generated PNG filename inside the ZIP
const imageFileMap = new Map<string, string>();

function traverseNode(node: SceneNode, fileKey: string, ancestorNames: string[] = []): NodeJSON {
  const json: NodeJSON = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    locked: node.locked,
    x: Math.round(node.x),
    y: Math.round(node.y),
    width: Math.round(node.width),
    height: Math.round(node.height),
  };

  // Rotation
  if ('rotation' in node && node.rotation !== 0) {
    json.rotation = node.rotation;
  }

  // Opacity
  if ('opacity' in node && node.opacity !== 1) {
    json.opacity = node.opacity;
  }

  // Blend mode
  if ('blendMode' in node && node.blendMode !== 'NORMAL' && node.blendMode !== 'PASS_THROUGH') {
    json.blendMode = node.blendMode;
  }

  // Constraints
  if ('constraints' in node) {
    json.constraints = {
      horizontal: node.constraints.horizontal,
      vertical: node.constraints.vertical,
    };
  }

  // Auto Layout
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    json.layoutMode = node.layoutMode;
    json.primaryAxisAlignItems = node.primaryAxisAlignItems;
    json.counterAxisAlignItems = node.counterAxisAlignItems;
    json.primaryAxisSizingMode = node.primaryAxisSizingMode;
    json.counterAxisSizingMode = node.counterAxisSizingMode;
    json.paddingTop = node.paddingTop;
    json.paddingRight = node.paddingRight;
    json.paddingBottom = node.paddingBottom;
    json.paddingLeft = node.paddingLeft;
    json.itemSpacing = node.itemSpacing;
    if ('counterAxisSpacing' in node && node.counterAxisSpacing !== null) {
      json.counterAxisSpacing = node.counterAxisSpacing as number;
    }
  }

  // Layout child properties
  if ('layoutAlign' in node) {
    json.layoutAlign = node.layoutAlign;
  }
  if ('layoutGrow' in node && node.layoutGrow !== 0) {
    json.layoutGrow = node.layoutGrow;
  }

  // Clips content
  if ('clipsContent' in node) {
    json.clipsContent = node.clipsContent;
  }

  // Fills
  if ('fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills)) {
    const fills = (node.fills as Paint[]).filter(f => f.visible !== false);
    if (fills.length > 0) {
      json.fills = fills.map(f => serializePaint(f, fileKey));
    }
  }

  // Strokes
  if ('strokes' in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
    json.strokes = (node.strokes as Paint[]).map(f => serializePaint(f, fileKey));
    if ('strokeWeight' in node) {
      json.strokeWeight = node.strokeWeight === figma.mixed ? 'mixed' as any : node.strokeWeight;
    }
    if ('strokeAlign' in node) {
      json.strokeAlign = node.strokeAlign;
    }
    if ('dashPattern' in node && (node as any).dashPattern?.length > 0) {
      json.dashPattern = (node as any).dashPattern;
    }
  }

  // Corner radius
  if ('cornerRadius' in node) {
    if (node.cornerRadius !== figma.mixed) {
      if (node.cornerRadius > 0) json.cornerRadius = node.cornerRadius;
    } else {
      json.cornerRadius = 'mixed' as any;
      json.topLeftRadius = (node as RectangleNode).topLeftRadius;
      json.topRightRadius = (node as RectangleNode).topRightRadius;
      json.bottomLeftRadius = (node as RectangleNode).bottomLeftRadius;
      json.bottomRightRadius = (node as RectangleNode).bottomRightRadius;
    }
  }

  // Effects
  if ('effects' in node && node.effects.length > 0) {
    json.effects = node.effects
      .filter(e => e.visible !== false)
      .map(e => serializeEffect(e));
  }

  // Text properties
  if (node.type === 'TEXT') {
    json.characters = node.characters;

    const fontSize = node.fontSize;
    if (fontSize !== figma.mixed) {
      json.fontSize = fontSize;
    } else {
      json.fontSize = 'mixed' as any;
    }

    const fontName = node.fontName;
    if (fontName !== figma.mixed) {
      json.fontFamily = fontName.family;
      json.fontWeight = fontName.style;
    }

    json.textAlignHorizontal = node.textAlignHorizontal;
    json.textAlignVertical = node.textAlignVertical;
    json.textAutoResize = node.textAutoResize;

    if (node.lineHeight !== figma.mixed) {
      const lh = node.lineHeight as LineHeight;
      json.lineHeight = lh.unit === 'AUTO' ? 'AUTO' : { value: lh.value, unit: lh.unit };
    }

    if (node.letterSpacing !== figma.mixed) {
      const ls = node.letterSpacing as LetterSpacing;
      if (ls.value !== 0) {
        json.letterSpacing = { value: ls.value, unit: ls.unit };
      }
    }

    if (node.textDecoration !== figma.mixed && node.textDecoration !== 'NONE') {
      json.textDecoration = node.textDecoration;
    }

    if (node.textCase !== figma.mixed && node.textCase !== 'ORIGINAL') {
      json.textCase = node.textCase;
    }

    if (node.paragraphSpacing > 0) {
      json.paragraphSpacing = node.paragraphSpacing;
    }
  }

  // Component detection
  if (node.type === 'COMPONENT') {
    json.isComponent = true;
    json.componentName = node.name;
  }

  if (node.type === 'INSTANCE') {
    json.isInstance = true;
    json.componentName = node.name;

    const mainComponent = node.mainComponent;
    if (mainComponent) {
      json.componentId = mainComponent.id;
      const existing = componentUsageMap.get(mainComponent.id);
      if (existing) {
        existing.count++;
      } else {
        componentUsageMap.set(mainComponent.id, {
          name: mainComponent.name,
          count: 1,
          firstInstanceId: node.id,
        });
      }
    }

    try {
      const props = node.componentProperties;
      if (props && Object.keys(props).length > 0) {
        json.componentProperties = {};
        for (const [key, val] of Object.entries(props)) {
          json.componentProperties[key] = {
            type: val.type,
            value: val.value,
          };
        }
      }
    } catch {
      // Some instances may not expose properties
    }
  }

  // Detect image fills — queue node for export
  let hasImageFill = false;
  if ('fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills)) {
    for (const fill of node.fills as Paint[]) {
      if (fill.type === 'IMAGE' && fill.imageHash) {
        hasImageFill = true;
        json.imageRef = fill.imageHash;

        // Check if we already queued this hash (same image used on multiple nodes)
        if (!imageFileMap.has(fill.imageHash)) {
          const baseName = safeFilename(node.name, node.id);
          imageFileMap.set(fill.imageHash, zipImagePath(baseName, 'png'));
          imageExportTasks.push({ nodeId: node.id, node, baseName });
        }

        json.imageFile = imageFileMap.get(fill.imageHash);
        break;
      }
    }
  }

  // Also export vector/icon nodes that aren't simple rectangles
  if (
    !hasImageFill &&
    (node.type === 'VECTOR' ||
      node.type === 'BOOLEAN_OPERATION' ||
      node.type === 'STAR' ||
      node.type === 'POLYGON' ||
      node.type === 'LINE' ||
      // Component instances that look like icons (small, or named with icon library prefix)
      (node.type === 'INSTANCE' && isLikelyIcon(node, ancestorNames)))
  ) {
    // Step 1: Check if this is a known-library icon (e.g., "feather/bell")
    const iconInfo = detectIconLibraryFromChain([node.name, ...ancestorNames]);
    if (iconInfo) {
      // Known icon → no export needed. AI can use the icon package.
      json.iconLibrary = iconInfo.library;
      json.iconName = iconInfo.iconName;
    } else {
      // Step 2: Dedup key priority — component main id > imageHash > node id
      let dedupKey = node.id;
      if (node.type === 'INSTANCE') {
        const mainId = (node as InstanceNode).mainComponent?.id;
        if (mainId) dedupKey = `component:${mainId}`;
      }

      if (imageFileMap.has(dedupKey)) {
        // Already queued — reuse the existing file path
        json.imageFile = imageFileMap.get(dedupKey);
      } else {
        const baseName = safeFilename(node.name, node.id);
        const file = zipImagePath(baseName, 'png');
        imageFileMap.set(dedupKey, file);
        imageExportTasks.push({ nodeId: node.id, node, baseName });
        json.imageFile = file;
      }
    }
  }

  // Traverse children — pass ancestor name chain so children can see parent library names
  if ('children' in node) {
    const childNodes = (node as FrameNode).children;
    if (childNodes && childNodes.length > 0) {
      const nextAncestors = [node.name, ...ancestorNames].slice(0, 5); // cap depth
      json.children = childNodes
        .filter(child => child.visible)
        .map(child => traverseNode(child, fileKey, nextAncestors));
    }
  }

  return json;
}

/** Patch image file references into fills that have imageRef */
function patchFillImageFiles(json: NodeJSON): void {
  if (json.fills) {
    for (const fill of json.fills) {
      if (fill.imageRef && imageFileMap.has(fill.imageRef)) {
        fill.imageFile = imageFileMap.get(fill.imageRef);
      }
    }
  }
  if (json.children) {
    for (const child of json.children) {
      patchFillImageFiles(child);
    }
  }
}

/** Rewrite all imageFile paths to full absolute paths */
function patchFullPaths(nodes: NodeJSON[], fullBasePath: string): void {
  for (const node of nodes) {
    if (node.imageFile) {
      node.imageFile = `${fullBasePath}/${node.imageFile}`;
    }
    if (node.fills) {
      for (const fill of node.fills) {
        if (fill.imageFile) {
          fill.imageFile = `${fullBasePath}/${fill.imageFile}`;
        }
      }
    }
    if (node.children) {
      patchFullPaths(node.children, fullBasePath);
    }
  }
}

/** Heuristic classifier — infers semantic role from layer name + Figma type */
function classifyNode(node: NodeJSON): string {
  const lower = node.name.toLowerCase();

  // Text always wins
  if (node.type === 'TEXT') return 'text';

  // Name-based classification (most reliable for well-named Figma files)
  if (/\b(input|field|textfield|text\s*field|textbox)\b/.test(lower)) return 'input';
  if (/\bsearch\b/.test(lower)) return 'input:search';
  if (/\b(button|btn|cta)\b/.test(lower)) return 'button';
  if (/\b(checkbox|radio|toggle|switch)\b/.test(lower)) return 'toggle';
  if (/\b(list|feed|table)\b/.test(lower)) return 'list';
  if (/\b(card|tile)\b/.test(lower)) return 'card';
  if (/\b(list\s*item|row|cell)\b/.test(lower)) return 'list-item';
  if (/\b(modal|dialog|sheet|popup|drawer)\b/.test(lower)) return 'modal';
  if (/\b(nav|navigation|tab\s*bar|bottom\s*bar|header|app\s*bar|status\s*bar)\b/.test(lower)) return 'navigation';
  if (/\b(icon)\b/.test(lower)) return 'icon';
  if (/\b(avatar|profile\s*pic|profile\s*image|thumbnail|photo|picture|image)\b/.test(lower)) return 'image';
  if (/\b(chip|tag|badge|pill)\b/.test(lower)) return 'chip';
  if (/\b(link)\b/.test(lower)) return 'link';
  if (/\b(divider|separator|line)\b/.test(lower)) return 'divider';

  // Image-fill detection
  if (node.imageRef || (node.fills && node.fills.some(f => f.type === 'IMAGE'))) return 'image';

  // Shape types become icons/images
  if (node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION' || node.type === 'STAR' || node.type === 'POLYGON') return 'icon';
  if (node.type === 'ELLIPSE') return 'icon';

  // Component instance — preserve reference
  if (node.isInstance && node.componentName) return 'component';

  return 'container';
}

/** Minimal backend-oriented representation. Strips ALL visuals (colors, fonts, spacing, padding). */
function toBackendNode(node: NodeJSON): any {
  const type = classifyNode(node);

  // Skip pure decorative shapes that add noise (lines, tiny rectangles with no children)
  if (type === 'divider') return null;

  const out: any = {
    name: node.name,
    type,
  };

  // Keep text content verbatim — this is gold for backend (labels, placeholders, button text)
  if (node.characters) out.text = node.characters;

  // Component references matter for backend (reusable patterns)
  if (node.isInstance && node.componentName) {
    out.component = node.componentName;
  }

  // Traverse children but filter nulls (dropped dividers etc.)
  if (node.children && node.children.length > 0) {
    const transformed = node.children
      .map(toBackendNode)
      .filter(c => c !== null);
    if (transformed.length > 0) out.children = transformed;
  }

  return out;
}

/** Strip a node JSON down to a compact summary (for compact output mode) */
function toCompactScreen(node: NodeJSON): any {
  const compact: any = {
    id: node.id,
    name: node.name,
    type: node.type,
    width: node.width,
    height: node.height,
  };
  // Carry over key visual props only
  if (node.fills && node.fills.length > 0) {
    const firstSolid = node.fills.find(f => f.type === 'SOLID');
    if (firstSolid?.color) {
      compact.fillColor = firstSolid.color;
    }
  }
  if (node.cornerRadius) compact.cornerRadius = node.cornerRadius;
  if (node.characters) compact.text = node.characters.slice(0, 100);
  if (node.fontFamily) compact.font = `${node.fontFamily} ${node.fontWeight || ''}`.trim();
  if (node.fontSize) compact.fontSize = node.fontSize;
  if (node.layoutMode && node.layoutMode !== 'NONE') compact.layout = node.layoutMode;
  if (node.iconLibrary && node.iconName) compact.icon = `${node.iconLibrary}/${node.iconName}`;
  else if (node.imageFile) compact.image = node.imageFile;
  if (node.isInstance && node.componentName) compact.component = node.componentName;
  if (node.semanticRole) compact.role = node.semanticRole;
  if (node.summary) compact.summary = node.summary;
  // Recursively summarize children
  if (node.children && node.children.length > 0) {
    compact.children = node.children.map(toCompactScreen);
  }
  return compact;
}

const screenToJson: Script = {
  id: 'screen-to-json',
  name: 'Screen to JSON',
  description: 'Generate a detailed AI-ready JSON from selected screens (ZIP with images)',
  hasConfig: true,
  async run(options?: ScreenToJsonOptions) {
    // Merge options with defaults
    const opts: ScreenToJsonOptions = { ...DEFAULT_SCREEN_TO_JSON_OPTIONS, ...(options || {}) };

    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.notify('Select one or more frames/screens first.');
      return;
    }

    // Read the saved base path (e.g. "~/projects/figma/assets")
    let basePath: string = await figma.clientStorage.getAsync(CLIENT_STORAGE_KEY) || '';
    if (!basePath) {
      figma.notify('Set your export base path first (in plugin settings).');
      figma.ui.postMessage({ type: 'show-settings' });
      return;
    }
    // Ensure no trailing slash
    basePath = basePath.replace(/\/+$/, '');

    // Generate timestamp for this export
    const timestamp = generateTimestamp();
    const zipFolderName = `figma-export-${timestamp}`;
    const fullBasePath = `${basePath}/${zipFolderName}`;

    // Reset tracking
    componentUsageMap.clear();
    imageExportTasks.length = 0;
    imageFileMap.clear();

    const fileKey = getFileKey();
    const screens: NodeJSON[] = [];

    // Phase 1: Traverse and build JSON (also collects image export tasks)
    figma.notify('Scanning screens...');
    for (const node of selection) {
      screens.push(traverseNode(node, fileKey));
    }

    // Patch fill imageFiles references
    for (const screen of screens) {
      patchFillImageFiles(screen);
    }

    // Phase 2: Create ZIP and (conditionally) export images
    const zip = new JSZip();
    const allExportedFiles: string[] = [];

    // Track byte hash -> canonical zip path so we can dedup identical renders
    const byteHashToPath = new Map<string, string>();
    // Remap: task.baseName -> canonical path (if this task's bytes matched an earlier one)
    const pathRemap = new Map<string, string>();

    if (opts.exportImages && imageExportTasks.length > 0) {
      figma.notify(`Exporting ${imageExportTasks.length} image(s) at ${IMAGE_SCALE}x...`);

      for (const task of imageExportTasks) {
        try {
          const pngBytes = await task.node.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: IMAGE_SCALE },
          });

          const pngZipPath = zipImagePath(task.baseName, 'png');
          const hash = hashBytes(pngBytes);

          if (byteHashToPath.has(hash)) {
            // Duplicate! Skip writing, remap references to the original file
            const canonical = byteHashToPath.get(hash)!;
            pathRemap.set(pngZipPath, canonical);
          } else {
            byteHashToPath.set(hash, pngZipPath);
            zip.file(pngZipPath, pngBytes);
            allExportedFiles.push(`${fullBasePath}/${pngZipPath}`);
          }
        } catch (err: any) {
          console.error(`Failed to export ${task.baseName}:`, err);
        }
      }

      // Apply path remaps to the JSON
      if (pathRemap.size > 0) {
        // Update imageFileMap entries so downstream patching picks up canonical paths
        for (const [key, val] of imageFileMap.entries()) {
          if (pathRemap.has(val)) {
            imageFileMap.set(key, pathRemap.get(val)!);
          }
        }
        // Also walk the already-built screens JSON to remap any direct imageFile refs
        remapImagePaths(screens, pathRemap);
      }
    }

    // Patch imageFiles on nodes to use full paths (only if images were exported)
    if (opts.exportImages) {
      patchFullPaths(screens, fullBasePath);
    } else {
      // Strip image file references if images not exported
      stripImageFiles(screens);
    }

    // Phase 3: Build reusable components map
    const reusableComponents: Record<string, { name: string; usageCount: number; firstInstanceId: string }> = {};
    for (const [id, data] of componentUsageMap.entries()) {
      if (data.count >= 2) {
        reusableComponents[id] = {
          name: data.name,
          usageCount: data.count,
          firstInstanceId: data.firstInstanceId,
        };
      }
    }

    // Phase 3.5: Optional AI enrichment
    const aiSettings: AISettings = await figma.clientStorage.getAsync(AI_SETTINGS_KEY) || DEFAULT_AI_SETTINGS;
    let aiEnriched = false;
    let flowDescription: string | undefined;
    let sharedComponents: Array<{ name: string; description: string; foundInScreens: string[] }> | undefined;
    const perScreenUsage: AIUsage[] = [];
    let totalUsage: AIUsage | undefined;

    // Backend mode is handled later (deterministic, no AI) — skip AI enrichment entirely for it
    if (opts.outputMode !== 'backend' && opts.aiEnabled && aiSettings.enabled) {
      figma.ui.postMessage({ type: 'ai-status', status: 'running' });

      if (opts.aiMode === 'per-screen') {
        // Per-screen mode: analyze each screen separately, then combine
        const screenSummaryData: Array<{ name: string; summary: string; screenType: string; keyElements: string[] }> = [];

        for (let i = 0; i < screens.length; i++) {
          const screen = screens[i];
          figma.notify(`AI analyzing screen ${i + 1}/${screens.length}: ${screen.name}`);
          figma.ui.postMessage({ type: 'ai-progress', current: i + 1, total: screens.length, screenName: screen.name });

          const singleResult = await enrichSingleScreen(screen, aiSettings);
          if (singleResult) {
            (screen as any).summary = singleResult.enrichment.summary;
            (screen as any).screenType = singleResult.enrichment.screenType;
            (screen as any).keyElements = singleResult.enrichment.keyElements;
            (screen as any).userActions = singleResult.enrichment.userActions;

            // Apply semantic roles from this screen's enrichment
            const applyRoles = (node: any) => {
              if (singleResult.enrichment.semanticRoles[node.id]) {
                node.semanticRole = singleResult.enrichment.semanticRoles[node.id];
              }
              if (node.children) {
                for (const child of node.children) applyRoles(child);
              }
            };
            applyRoles(screen);

            perScreenUsage.push(singleResult.usage);
            screenSummaryData.push({
              name: screen.name,
              summary: singleResult.enrichment.summary,
              screenType: singleResult.enrichment.screenType,
              keyElements: singleResult.enrichment.keyElements,
            });
          }
        }

        // Final combine step: overall flow analysis
        if (screenSummaryData.length > 0) {
          figma.notify('AI combining screens for flow analysis...');
          const combined = await combineScreenSummaries(screenSummaryData, aiSettings);
          if (combined) {
            flowDescription = combined.flowDescription;
            sharedComponents = combined.sharedComponents;
            perScreenUsage.push(combined.usage);
          }
          aiEnriched = true;
        }

        // Aggregate usage
        if (perScreenUsage.length > 0) {
          const first = perScreenUsage[0];
          totalUsage = {
            provider: first.provider,
            model: first.model,
            promptTokens: perScreenUsage.reduce((s, u) => s + u.promptTokens, 0),
            completionTokens: perScreenUsage.reduce((s, u) => s + u.completionTokens, 0),
            totalTokens: perScreenUsage.reduce((s, u) => s + u.totalTokens, 0),
            estimatedCostUSD: perScreenUsage.reduce((s, u) => s + u.estimatedCostUSD, 0),
            durationMs: perScreenUsage.reduce((s, u) => s + u.durationMs, 0),
          };
          figma.ui.postMessage({ type: 'ai-status', status: 'done', usage: totalUsage });
        } else {
          figma.ui.postMessage({ type: 'ai-status', status: 'failed' });
        }
      } else {
        // Bulk mode: send everything at once (original behavior)
        figma.notify(`Analyzing with AI (${aiSettings.provider})...`);

        const result = await enrichScreenJSON({ screens, reusableComponents }, aiSettings);

        if (result) {
          aiEnriched = true;
          applyEnrichment(screens, result.enrichment);
          flowDescription = result.enrichment.flowDescription;
          sharedComponents = result.enrichment.sharedComponents;
          totalUsage = result.usage;
          figma.ui.postMessage({ type: 'ai-status', status: 'done', usage: result.usage });
        } else {
          figma.ui.postMessage({ type: 'ai-status', status: 'failed' });
        }
      }
    }

    // Build final output based on mode
    let output: any;

    if (opts.outputMode === 'backend') {
      // Backend mode: minimal deterministic extraction (no AI)
      // Strips all visual/styling info. Keeps only what a backend dev needs:
      // layer names, text content, semantic classification, hierarchy
      const backendScreens = screens.map(toBackendNode);
      output = {
        exportedAt: new Date().toISOString(),
        figmaFileKey: fileKey,
        outputMode: 'backend',
        note: 'Minimal structural extraction. Feed this to your own AI to analyze backend requirements.',
        screens: backendScreens,
      };
    } else if (opts.outputMode === 'detailed') {
      // Detailed mode: minimal, token-referenced, semantic JSON (build-ready)
      const built = buildModeTransform(screens as any[]);
      output = built;
      // Attach optional AI-generated insights if present (kept OUT of each node)
      if (aiEnriched) {
        (output as any).aiInsights = {
          flowDescription,
          sharedComponents,
        };
      }
      if (opts.exportImages && allExportedFiles.length > 0) {
        (output as any).exportedImages = allExportedFiles;
      }
    } else {
      // Compact mode (old behaviour)
      const outputScreens = screens.map(toCompactScreen);

      output = {
        exportedAt: new Date().toISOString(),
        figmaFileKey: fileKey,
        exportPath: fullBasePath,
        outputMode: opts.outputMode,
        imageScale: opts.exportImages ? IMAGE_SCALE : undefined,
        imageFormat: opts.exportImages ? 'png' : undefined,
        aiEnriched,
        aiMode: opts.aiEnabled ? opts.aiMode : undefined,
        flowDescription,
        sharedComponents,
        screens: outputScreens,
        reusableComponents,
        exportedImages: opts.exportImages ? allExportedFiles : undefined,
      };
    }

    // Remove undefined fields for clean JSON
    Object.keys(output).forEach(k => output[k] === undefined && delete output[k]);

    const jsonString = JSON.stringify(output, null, 2);

    // Add JSON to ZIP
    zip.file('screen.json', jsonString);

    // Phase 4: Generate ZIP and send to UI
    figma.notify('Packing ZIP...');
    const zipBlob = await zip.generateAsync({ type: 'uint8array' });

    // Send JSON to UI for preview/copy FIRST
    figma.ui.postMessage({
      type: 'json-output',
      json: jsonString,
      screenCount: screens.length,
      componentCount: Object.keys(reusableComponents).length,
      imageCount: opts.exportImages ? imageExportTasks.length : 0,
    });

    // Send ZIP SECOND
    const zipName = opts.outputMode === 'backend'
      ? `${zipFolderName}-backend.zip`
      : opts.outputMode === 'compact'
        ? `${zipFolderName}-compact.zip`
        : `${zipFolderName}.zip`;
    figma.ui.postMessage({
      type: 'download-zip',
      bytes: Array.from(zipBlob),
      zipFilename: zipName,
      screenCount: screens.length,
      componentCount: Object.keys(reusableComponents).length,
      imageCount: opts.exportImages ? imageExportTasks.length : 0,
    });

    figma.notify(
      `Done! ${screens.length} screen(s), ${Object.keys(reusableComponents).length} reusable, ${opts.exportImages ? imageExportTasks.length + ' image(s)' : 'no images'}.`
    );
  },
};

/**
 * Fast non-cryptographic hash for byte arrays (FNV-1a 64-bit).
 * Collisions are astronomically unlikely for our use case (rendered PNG dedup).
 */
function hashBytes(bytes: Uint8Array): string {
  // FNV-1a 64-bit
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < bytes.length; i++) {
    lo ^= bytes[i];
    // 64-bit FNV prime multiplication: 0x100000001b3
    const hiNew = (hi * 0x01000001 + lo * 0x00000000) >>> 0;
    const loNew = (lo * 0x000001b3) >>> 0;
    hi = hiNew;
    lo = loNew;
  }
  return `${hi.toString(16).padStart(8, '0')}${lo.toString(16).padStart(8, '0')}`;
}

/** Walk the JSON and remap any imageFile path that matches a key in pathRemap */
function remapImagePaths(nodes: NodeJSON[], pathRemap: Map<string, string>): void {
  for (const node of nodes) {
    if (node.imageFile && pathRemap.has(node.imageFile)) {
      node.imageFile = pathRemap.get(node.imageFile)!;
    }
    if (node.fills) {
      for (const fill of node.fills) {
        if (fill.imageFile && pathRemap.has(fill.imageFile)) {
          fill.imageFile = pathRemap.get(fill.imageFile)!;
        }
      }
    }
    if (node.children) remapImagePaths(node.children, pathRemap);
  }
}

/** Remove image file references from nodes when images are not exported */
function stripImageFiles(nodes: NodeJSON[]): void {
  for (const node of nodes) {
    delete node.imageFile;
    delete node.imageRef;
    if (node.fills) {
      for (const fill of node.fills) {
        delete fill.imageFile;
        delete fill.imageRef;
      }
    }
    if (node.children) stripImageFiles(node.children);
  }
}

export default screenToJson;
