import { Script } from './types';
import JSZip from 'jszip';

// ============================================================
// Screen to JSON — Extracts a detailed JSON blueprint from
// selected Figma frames/screens for AI-driven UI generation.
//
// Everything is bundled into a single ZIP file:
//   figma-export.zip
//     ├── screen.json          (the full JSON blueprint)
//     └── images/
//         ├── avatar-12-34@1.5x.png
//         ├── avatar-12-34@1.5x.jpg
//         └── ...
//
// ONE save dialog. Unzip and you have everything.
// JSON references images as: "images/avatar-12-34@1.5x.png"
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
  imageFiles?: { png: string; jpeg: string };

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
  imageFiles?: { png: string; jpeg: string };
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

const IMAGE_SCALE = 1.5;
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

/** Path inside the ZIP for an image file */
function zipImagePath(baseName: string, ext: string): string {
  return `${IMAGES_FOLDER}/${baseName}@1.5x.${ext}`;
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
// Map from imageRef (hash or nodeId) to the generated filenames inside the ZIP
const imageFileMap = new Map<string, { png: string; jpeg: string }>();

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
          imageFileMap.set(fill.imageHash, {
            png: zipImagePath(baseName, 'png'),
            jpeg: zipImagePath(baseName, 'jpg'),
          });
          imageExportTasks.push({ nodeId: node.id, node, baseName });
        }

        json.imageFiles = imageFileMap.get(fill.imageHash);
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
      node.type === 'LINE')
  ) {
    const baseName = safeFilename(node.name, node.id);
    const files = {
      png: zipImagePath(baseName, 'png'),
      jpeg: zipImagePath(baseName, 'jpg'),
    };
    imageFileMap.set(node.id, files);
    imageExportTasks.push({ nodeId: node.id, node, baseName });
    json.imageFiles = files;
  }

  // Traverse children
  if ('children' in node) {
    const childNodes = (node as FrameNode).children;
    if (childNodes && childNodes.length > 0) {
      json.children = childNodes
        .filter(child => child.visible)
        .map(child => traverseNode(child, fileKey));
    }
  }

  return json;
}

/** Patch image file references into fills that have imageRef */
function patchFillImageFiles(json: NodeJSON): void {
  if (json.fills) {
    for (const fill of json.fills) {
      if (fill.imageRef && imageFileMap.has(fill.imageRef)) {
        fill.imageFiles = imageFileMap.get(fill.imageRef);
      }
    }
  }
  if (json.children) {
    for (const child of json.children) {
      patchFillImageFiles(child);
    }
  }
}

/** Rewrite all imageFiles paths to full absolute paths */
function patchFullPaths(nodes: NodeJSON[], fullBasePath: string): void {
  for (const node of nodes) {
    if (node.imageFiles) {
      node.imageFiles = {
        png: `${fullBasePath}/${node.imageFiles.png}`,
        jpeg: `${fullBasePath}/${node.imageFiles.jpeg}`,
      };
    }
    if (node.fills) {
      for (const fill of node.fills) {
        if (fill.imageFiles) {
          fill.imageFiles = {
            png: `${fullBasePath}/${fill.imageFiles.png}`,
            jpeg: `${fullBasePath}/${fill.imageFiles.jpeg}`,
          };
        }
      }
    }
    if (node.children) {
      patchFullPaths(node.children, fullBasePath);
    }
  }
}

const screenToJson: Script = {
  id: 'screen-to-json',
  name: 'Screen to JSON',
  description: 'Generate a detailed AI-ready JSON from selected screens (ZIP with images)',
  async run() {
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

    // Phase 2: Create ZIP and export images into it
    const zip = new JSZip();
    const allExportedFiles: string[] = [];

    if (imageExportTasks.length > 0) {
      figma.notify(`Exporting ${imageExportTasks.length} image(s) at ${IMAGE_SCALE}x...`);

      for (const task of imageExportTasks) {
        try {
          const pngBytes = await task.node.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: IMAGE_SCALE },
          });

          const jpgBytes = await task.node.exportAsync({
            format: 'JPG',
            constraint: { type: 'SCALE', value: IMAGE_SCALE },
          });

          const pngZipPath = zipImagePath(task.baseName, 'png');
          const jpgZipPath = zipImagePath(task.baseName, 'jpg');

          zip.file(pngZipPath, pngBytes);
          zip.file(jpgZipPath, jpgBytes);

          // Full paths for the JSON (basePath + zipFolder + image path)
          allExportedFiles.push(
            `${fullBasePath}/${pngZipPath}`,
            `${fullBasePath}/${jpgZipPath}`
          );
        } catch (err: any) {
          console.error(`Failed to export ${task.baseName}:`, err);
        }
      }
    }

    // Also patch imageFiles on nodes to use full paths
    patchFullPaths(screens, fullBasePath);

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

    const output: ScreenJSON = {
      exportedAt: new Date().toISOString(),
      figmaFileKey: fileKey,
      exportPath: fullBasePath,
      imageScale: IMAGE_SCALE,
      imageFormats: ['png', 'jpeg'],
      screens,
      reusableComponents,
      exportedImages: allExportedFiles,
    };

    const jsonString = JSON.stringify(output, null, 2);

    // Add JSON to ZIP
    zip.file('screen.json', jsonString);

    // Phase 4: Generate ZIP and send to UI for single download
    figma.notify('Packing ZIP...');
    const zipBlob = await zip.generateAsync({ type: 'uint8array' });

    // Send JSON to UI for preview/copy FIRST
    figma.ui.postMessage({
      type: 'json-output',
      json: jsonString,
      screenCount: screens.length,
      componentCount: Object.keys(reusableComponents).length,
      imageCount: imageExportTasks.length,
    });

    // Send ZIP SECOND — so it overwrites the initial disabled state
    figma.ui.postMessage({
      type: 'download-zip',
      bytes: Array.from(zipBlob),
      zipFilename: `${zipFolderName}.zip`,
      screenCount: screens.length,
      componentCount: Object.keys(reusableComponents).length,
      imageCount: imageExportTasks.length,
    });

    figma.notify(
      `Done! ${screens.length} screen(s), ${Object.keys(reusableComponents).length} reusable component(s), ${imageExportTasks.length} image(s).`
    );
  },
};

export default screenToJson;
