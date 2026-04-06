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

  // scripts/index.ts
  var scripts = [
    square_to_circle_default,
    thinking_div_default
    // Add new scripts here:
    // import myNewScript from './my-new-script';
    // myNewScript,
  ];

  // code.ts
  figma.showUI(__html__, { width: 320, height: 400 });
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
