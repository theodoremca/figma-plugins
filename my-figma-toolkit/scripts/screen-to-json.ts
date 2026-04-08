import { Script } from './types';

// ============================================================
// Screen to JSON — Extracts a detailed JSON blueprint from
// selected Figma frames/screens for AI-driven UI generation.
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

  // Image
  imageRef?: string;
  figmaImageUrl?: string;

  // Component info
  isComponent?: boolean;
  isInstance?: boolean;
  componentName?: string;
  componentId?: string;
  componentProperties?: Record<string, any>;

  // Vector / Boolean
  vectorPaths?: string;
  booleanOperation?: string;

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
  figmaImageUrl?: string;
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
  screens: NodeJSON[];
  reusableComponents: Record<string, { name: string; usageCount: number; firstInstanceId: string }>;
}

// ---- Helpers ----

function rgbaFromFigma(color: RGB | RGBA, opacity?: number): { r: number; g: number; b: number; a: number } {
  return {
    r: Math.round(color.r * 255),
    g: Math.round(color.g * 255),
    b: Math.round(color.b * 255),
    a: parseFloat((('a' in color ? color.a : 1) * (opacity ?? 1)).toFixed(2)),
  };
}

function serializePaint(paint: Paint, fileKey: string): SerializedPaint {
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
      base.figmaImageUrl = `https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/${fileKey}/${paint.imageHash}`;
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
  // Figma plugin API doesn't directly expose file key,
  // but we can extract it from the document root
  try {
    return (figma as any).fileKey || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Track component usage for reusable component detection
const componentUsageMap = new Map<string, { name: string; count: number; firstInstanceId: string }>();

function traverseNode(node: SceneNode, fileKey: string): NodeJSON {
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
    json.layoutMode = node.layoutMode; // HORIZONTAL or VERTICAL
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
      json.strokeWeight = node.strokeWeight;
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
      json.fontWeight = fontName.style; // e.g. "Bold", "Regular", "Semi Bold"
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

    // Track main component for reusable component detection
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

    // Component properties (variant values, boolean props, etc.)
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

  // Detect image fills and provide Figma image URL
  if ('fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills)) {
    for (const fill of node.fills as Paint[]) {
      if (fill.type === 'IMAGE' && fill.imageHash) {
        json.imageRef = fill.imageHash;
        json.figmaImageUrl = `https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/${fileKey}/${fill.imageHash}`;
        break;
      }
    }
  }

  // Traverse children
  if ('children' in node) {
    const childNodes = (node as FrameNode).children;
    if (childNodes && childNodes.length > 0) {
      json.children = childNodes
        .filter(child => child.visible) // skip hidden layers
        .map(child => traverseNode(child, fileKey));
    }
  }

  return json;
}

const screenToJson: Script = {
  id: 'screen-to-json',
  name: 'Screen to JSON',
  description: 'Generate a detailed AI-ready JSON from selected screens',
  async run() {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.notify('Select one or more frames/screens first.');
      return;
    }

    // Reset component usage tracking
    componentUsageMap.clear();

    const fileKey = getFileKey();
    const screens: NodeJSON[] = [];

    for (const node of selection) {
      screens.push(traverseNode(node, fileKey));
    }

    // Build reusable components map (components used 2+ times across all screens)
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

    const output: ScreenJSON = {
      exportedAt: new Date().toISOString(),
      figmaFileKey: fileKey,
      screens,
      reusableComponents,
    };

    const jsonString = JSON.stringify(output, null, 2);

    // Send to UI for display/copy
    figma.ui.postMessage({
      type: 'json-output',
      json: jsonString,
      screenCount: screens.length,
      componentCount: Object.keys(reusableComponents).length,
    });

    figma.notify(`Extracted ${screens.length} screen(s) with ${Object.keys(reusableComponents).length} reusable component(s).`);
  },
};

export default screenToJson;
