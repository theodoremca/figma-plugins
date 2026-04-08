"use strict";
(() => {
  // scripts/square-to-circle.ts
  var squareToCircle = {
    id: "square-to-circle",
    name: "Square to Circle",
    description: "Converts selected rectangles into ellipses (circles)",
    run() {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        figma.notify("Select at least one rectangle first.");
        return;
      }
      let converted = 0;
      const newSelection = [];
      for (const node of selection) {
        if (node.type === "RECTANGLE") {
          const ellipse = figma.createEllipse();
          ellipse.x = node.x;
          ellipse.y = node.y;
          ellipse.resize(node.width, node.height);
          ellipse.fills = JSON.parse(JSON.stringify(node.fills));
          ellipse.strokes = JSON.parse(JSON.stringify(node.strokes));
          ellipse.strokeWeight = node.strokeWeight;
          ellipse.opacity = node.opacity;
          ellipse.name = node.name + " (circle)";
          if (node.parent) {
            const index = node.parent.children.indexOf(node);
            node.parent.insertChild(index, ellipse);
          }
          node.remove();
          newSelection.push(ellipse);
          converted++;
        }
      }
      figma.currentPage.selection = newSelection;
      figma.notify(`Converted ${converted} rectangle(s) to circle(s).`);
    }
  };
  var square_to_circle_default = squareToCircle;

  // scripts/thinking-div.ts
  var C = {
    gold: { r: 245 / 255, g: 158 / 255, b: 11 / 255 },
    platinum: { r: 168 / 255, g: 169 / 255, b: 171 / 255 },
    fafafa: { r: 250 / 255, g: 250 / 255, b: 250 / 255 }
  };
  var MESSAGES = [
    "Understanding your vision\u2026",
    "Analysing space requirements\u2026",
    "AI matching availability & ratings\u2026",
    "Curating the best spaces for you\u2026"
  ];
  var BASELINE = 8;
  var SEQUENCE = [
    // ── msg0: "Understanding your vision…" ──────────────────── t=0 → 650ms ──
    { msgIdx: 0, dots: [0, 0, 0], opacities: [0.4, 0.4, 0.4], holdMs: 0, transMs: 330 },
    // t=0    rest
    { msgIdx: 0, dots: [-8, -4.6, -0.2], opacities: [1, 0.74, 0.41], holdMs: 0, transMs: 150 },
    // t=330  dot1↑
    { msgIdx: 0, dots: [-4.6, -8, -4.6], opacities: [0.74, 1, 0.74], holdMs: 0, transMs: 150 },
    // t=480  dot2↑
    { msgIdx: 0, dots: [-0.2, -4.6, -8], opacities: [0.41, 0.74, 1], holdMs: 20, transMs: 0 },
    // t=630  dot3↑ → INSTANT text swap
    // ── msg1: "Analysing space requirements…" ──────────────── t=650 → 1300ms ──
    { msgIdx: 1, dots: [-0.2, -4.6, -8], opacities: [0.41, 0.74, 1], holdMs: 0, transMs: 330 },
    // t=650  dot3 falling
    { msgIdx: 1, dots: [0, 0, 0], opacities: [0.4, 0.4, 0.4], holdMs: 140, transMs: 180 },
    // t=980  rest (hold+trans = 320ms → t=1300)
    { msgIdx: 1, dots: [-5.3, -0.4, 0], opacities: [0.8, 0.43, 0.4], holdMs: 0, transMs: 0 },
    // t=1300 mid-rise → INSTANT text swap
    // ── msg2: "AI matching availability & ratings…" ───────── t=1300 → 1950ms ──
    { msgIdx: 2, dots: [-5.3, -0.4, 0], opacities: [0.8, 0.43, 0.4], holdMs: 0, transMs: 130 },
    // t=1300 dot1 mid-rise
    { msgIdx: 2, dots: [-8, -4.6, -0.2], opacities: [1, 0.74, 0.41], holdMs: 0, transMs: 150 },
    // t=1430 dot1↑
    { msgIdx: 2, dots: [-4.6, -8, -4.6], opacities: [0.74, 1, 0.74], holdMs: 0, transMs: 150 },
    // t=1580 dot2↑
    { msgIdx: 2, dots: [-0.2, -4.6, -8], opacities: [0.41, 0.74, 1], holdMs: 0, transMs: 220 },
    // t=1730 dot3↑ → settles
    { msgIdx: 2, dots: [0, 0, -1.1], opacities: [0.4, 0.4, 0.48], holdMs: 0, transMs: 0 },
    // t=1950 nearly rest → INSTANT text swap
    // ── msg3: "Curating the best spaces for you…" ─────────── t=1950 → 2600ms ──
    { msgIdx: 3, dots: [0, 0, -1.1], opacities: [0.4, 0.4, 0.48], holdMs: 0, transMs: 130 },
    // t=1950
    { msgIdx: 3, dots: [0, 0, 0], opacities: [0.4, 0.4, 0.4], holdMs: 120, transMs: 330 },
    // t=2080 rest (hold+trans = 450ms → t=2530)
    { msgIdx: 3, dots: [-8, -4.6, -0.2], opacities: [1, 0.74, 0.41], holdMs: 70, transMs: 0 }
    // t=2530 dot1↑ → INSTANT loop back at t=2600
    // → loops to frame 0 (instant cut; dots snap to rest — barely perceptible at end of cycle)
  ];
  function buildFrame(spec, fontName) {
    const container = figma.createFrame();
    container.name = "thinking-state";
    container.layoutMode = "HORIZONTAL";
    container.primaryAxisAlignItems = "CENTER";
    container.counterAxisAlignItems = "CENTER";
    container.itemSpacing = 10;
    container.paddingTop = 12;
    container.paddingBottom = 12;
    container.paddingLeft = 16;
    container.paddingRight = 16;
    container.fills = [{ type: "SOLID", color: C.fafafa }];
    container.cornerRadius = 14;
    container.primaryAxisSizingMode = "AUTO";
    container.counterAxisSizingMode = "AUTO";
    const dotsWrapper = figma.createFrame();
    dotsWrapper.name = "thinking-dots";
    dotsWrapper.layoutMode = "NONE";
    dotsWrapper.fills = [];
    dotsWrapper.resize(29, BASELINE + 7);
    for (let i = 0; i < 3; i++) {
      const dot = figma.createEllipse();
      dot.name = `t-dot-${i + 1}`;
      dot.resize(7, 7);
      dot.x = i * 11;
      dot.y = BASELINE + spec.dots[i];
      dot.fills = [{ type: "SOLID", color: C.gold }];
      dot.opacity = spec.opacities[i];
      dotsWrapper.appendChild(dot);
    }
    const text = figma.createText();
    text.name = "thinkingMsg";
    text.fontName = fontName;
    text.fontSize = 13;
    text.fills = [{ type: "SOLID", color: C.platinum }];
    text.characters = MESSAGES[spec.msgIdx];
    text.textAutoResize = "WIDTH_AND_HEIGHT";
    container.appendChild(dotsWrapper);
    container.appendChild(text);
    return container;
  }
  var thinkingDiv = {
    id: "thinking-div",
    name: "Thinking Div \u2014 Looping",
    description: "Creates the AI processing state with dot-bounce + cycling text",
    async run() {
      let fontName;
      try {
        await figma.loadFontAsync({ family: "Lato", style: "Semi Bold" });
        fontName = { family: "Lato", style: "Semi Bold" };
      } catch (e) {
        await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });
        fontName = { family: "Inter", style: "Semi Bold" };
      }
      const { x: cx, y: cy } = figma.viewport.center;
      const frames = [];
      for (let i = 0; i < SEQUENCE.length; i++) {
        const frame = buildFrame(SEQUENCE[i], fontName);
        frame.x = cx + i * (frame.width + 24);
        frame.y = cy;
        figma.currentPage.appendChild(frame);
        frames.push(frame);
      }
      for (let i = 0; i < frames.length; i++) {
        const spec = SEQUENCE[i];
        const next = frames[(i + 1) % frames.length];
        frames[i].reactions = [
          {
            trigger: {
              type: "AFTER_TIMEOUT",
              timeout: Math.max(spec.holdMs / 1e3, 1e-3)
              // min 1ms to avoid API issues
            },
            actions: [
              {
                type: "NODE",
                destinationId: next.id,
                navigation: "NAVIGATE",
                transition: spec.transMs > 0 ? {
                  type: "SMART_ANIMATE",
                  easing: { type: "EASE_IN_AND_OUT" },
                  duration: spec.transMs / 1e3
                } : null,
                preserveScrollPosition: false
              }
            ]
          }
        ];
      }
      figma.currentPage.selection = frames;
      figma.viewport.scrollAndZoomIntoView(frames);
      figma.notify("Done \u2014 15 frames created. Start prototype from the first frame.");
    }
  };
  var thinking_div_default = thinkingDiv;

  // scripts/screen-to-json.ts
  function rgbaFromFigma(color, opacity) {
    return {
      r: Math.round(color.r * 255),
      g: Math.round(color.g * 255),
      b: Math.round(color.b * 255),
      a: parseFloat((("a" in color ? color.a : 1) * (opacity != null ? opacity : 1)).toFixed(2))
    };
  }
  function serializePaint(paint, fileKey) {
    var _a;
    const base = {
      type: paint.type,
      visible: paint.visible !== false,
      opacity: (_a = paint.opacity) != null ? _a : 1,
      blendMode: paint.blendMode
    };
    if (paint.type === "SOLID") {
      base.color = rgbaFromFigma(paint.color, paint.opacity);
    }
    if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_DIAMOND") {
      base.gradientStops = paint.gradientStops.map((s) => ({
        position: s.position,
        color: rgbaFromFigma(s.color)
      }));
      base.gradientTransform = paint.gradientTransform;
    }
    if (paint.type === "IMAGE") {
      base.scaleMode = paint.scaleMode;
      if (paint.imageHash) {
        base.imageRef = paint.imageHash;
        base.figmaImageUrl = `https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/${fileKey}/${paint.imageHash}`;
      }
    }
    return base;
  }
  function serializeEffect(effect) {
    const e = {
      type: effect.type,
      visible: effect.visible !== false,
      radius: effect.radius
    };
    if ("color" in effect && effect.color) {
      e.color = rgbaFromFigma(effect.color);
    }
    if ("offset" in effect && effect.offset) {
      e.offset = { x: effect.offset.x, y: effect.offset.y };
    }
    if ("spread" in effect) {
      e.spread = effect.spread;
    }
    if (effect.blendMode) {
      e.blendMode = effect.blendMode;
    }
    return e;
  }
  function getFileKey() {
    try {
      return figma.fileKey || "unknown";
    } catch (e) {
      return "unknown";
    }
  }
  var componentUsageMap = /* @__PURE__ */ new Map();
  function traverseNode(node, fileKey) {
    var _a;
    const json = {
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible,
      locked: node.locked,
      x: Math.round(node.x),
      y: Math.round(node.y),
      width: Math.round(node.width),
      height: Math.round(node.height)
    };
    if ("rotation" in node && node.rotation !== 0) {
      json.rotation = node.rotation;
    }
    if ("opacity" in node && node.opacity !== 1) {
      json.opacity = node.opacity;
    }
    if ("blendMode" in node && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH") {
      json.blendMode = node.blendMode;
    }
    if ("constraints" in node) {
      json.constraints = {
        horizontal: node.constraints.horizontal,
        vertical: node.constraints.vertical
      };
    }
    if ("layoutMode" in node && node.layoutMode !== "NONE") {
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
      if ("counterAxisSpacing" in node && node.counterAxisSpacing !== null) {
        json.counterAxisSpacing = node.counterAxisSpacing;
      }
    }
    if ("layoutAlign" in node) {
      json.layoutAlign = node.layoutAlign;
    }
    if ("layoutGrow" in node && node.layoutGrow !== 0) {
      json.layoutGrow = node.layoutGrow;
    }
    if ("clipsContent" in node) {
      json.clipsContent = node.clipsContent;
    }
    if ("fills" in node && node.fills !== figma.mixed && Array.isArray(node.fills)) {
      const fills = node.fills.filter((f) => f.visible !== false);
      if (fills.length > 0) {
        json.fills = fills.map((f) => serializePaint(f, fileKey));
      }
    }
    if ("strokes" in node && Array.isArray(node.strokes) && node.strokes.length > 0) {
      json.strokes = node.strokes.map((f) => serializePaint(f, fileKey));
      if ("strokeWeight" in node) {
        json.strokeWeight = node.strokeWeight;
      }
      if ("strokeAlign" in node) {
        json.strokeAlign = node.strokeAlign;
      }
      if ("dashPattern" in node && ((_a = node.dashPattern) == null ? void 0 : _a.length) > 0) {
        json.dashPattern = node.dashPattern;
      }
    }
    if ("cornerRadius" in node) {
      if (node.cornerRadius !== figma.mixed) {
        if (node.cornerRadius > 0) json.cornerRadius = node.cornerRadius;
      } else {
        json.cornerRadius = "mixed";
        json.topLeftRadius = node.topLeftRadius;
        json.topRightRadius = node.topRightRadius;
        json.bottomLeftRadius = node.bottomLeftRadius;
        json.bottomRightRadius = node.bottomRightRadius;
      }
    }
    if ("effects" in node && node.effects.length > 0) {
      json.effects = node.effects.filter((e) => e.visible !== false).map((e) => serializeEffect(e));
    }
    if (node.type === "TEXT") {
      json.characters = node.characters;
      const fontSize = node.fontSize;
      if (fontSize !== figma.mixed) {
        json.fontSize = fontSize;
      } else {
        json.fontSize = "mixed";
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
        const lh = node.lineHeight;
        json.lineHeight = lh.unit === "AUTO" ? "AUTO" : { value: lh.value, unit: lh.unit };
      }
      if (node.letterSpacing !== figma.mixed) {
        const ls = node.letterSpacing;
        if (ls.value !== 0) {
          json.letterSpacing = { value: ls.value, unit: ls.unit };
        }
      }
      if (node.textDecoration !== figma.mixed && node.textDecoration !== "NONE") {
        json.textDecoration = node.textDecoration;
      }
      if (node.textCase !== figma.mixed && node.textCase !== "ORIGINAL") {
        json.textCase = node.textCase;
      }
      if (node.paragraphSpacing > 0) {
        json.paragraphSpacing = node.paragraphSpacing;
      }
    }
    if (node.type === "COMPONENT") {
      json.isComponent = true;
      json.componentName = node.name;
    }
    if (node.type === "INSTANCE") {
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
            firstInstanceId: node.id
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
              value: val.value
            };
          }
        }
      } catch (e) {
      }
    }
    if ("fills" in node && node.fills !== figma.mixed && Array.isArray(node.fills)) {
      for (const fill of node.fills) {
        if (fill.type === "IMAGE" && fill.imageHash) {
          json.imageRef = fill.imageHash;
          json.figmaImageUrl = `https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/${fileKey}/${fill.imageHash}`;
          break;
        }
      }
    }
    if ("children" in node) {
      const childNodes = node.children;
      if (childNodes && childNodes.length > 0) {
        json.children = childNodes.filter((child) => child.visible).map((child) => traverseNode(child, fileKey));
      }
    }
    return json;
  }
  var screenToJson = {
    id: "screen-to-json",
    name: "Screen to JSON",
    description: "Generate a detailed AI-ready JSON from selected screens",
    async run() {
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        figma.notify("Select one or more frames/screens first.");
        return;
      }
      componentUsageMap.clear();
      const fileKey = getFileKey();
      const screens = [];
      for (const node of selection) {
        screens.push(traverseNode(node, fileKey));
      }
      const reusableComponents = {};
      for (const [id, data] of componentUsageMap.entries()) {
        if (data.count >= 2) {
          reusableComponents[id] = {
            name: data.name,
            usageCount: data.count,
            firstInstanceId: data.firstInstanceId
          };
        }
      }
      const output = {
        exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
        figmaFileKey: fileKey,
        screens,
        reusableComponents
      };
      const jsonString = JSON.stringify(output, null, 2);
      figma.ui.postMessage({
        type: "json-output",
        json: jsonString,
        screenCount: screens.length,
        componentCount: Object.keys(reusableComponents).length
      });
      figma.notify(`Extracted ${screens.length} screen(s) with ${Object.keys(reusableComponents).length} reusable component(s).`);
    }
  };
  var screen_to_json_default = screenToJson;

  // scripts/index.ts
  var scripts = [
    square_to_circle_default,
    thinking_div_default,
    screen_to_json_default
    // Add new scripts here:
    // import myNewScript from './my-new-script';
    // myNewScript,
  ];

  // code.ts
  figma.showUI(__html__, { width: 400, height: 500 });
  var scriptList = scripts.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description
  }));
  figma.ui.postMessage({ type: "script-list", scripts: scriptList });
  figma.ui.onmessage = (msg) => {
    if (msg.type === "run-script" && msg.scriptId) {
      const script = scripts.find((s) => s.id === msg.scriptId);
      if (script) {
        Promise.resolve(script.run()).then(() => {
          figma.ui.postMessage({ type: "done", scriptId: script.id });
        }).catch((err) => {
          figma.notify("Error: " + (err.message || String(err)));
          figma.ui.postMessage({ type: "error", message: err.message || String(err) });
        });
      }
    }
  };
})();
