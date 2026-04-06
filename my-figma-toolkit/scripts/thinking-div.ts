import { Script } from './types';

const C = {
  gold:     { r: 245/255, g: 158/255, b: 11/255  },
  platinum: { r: 168/255, g: 169/255, b: 171/255 },
  fafafa:   { r: 250/255, g: 250/255, b: 250/255 },
};

const MESSAGES = [
  'Understanding your vision…',
  'Analysing space requirements…',
  'AI matching availability & ratings…',
  'Curating the best spaces for you…',
];

// Baseline Y for dots (rest position). Negative offsets move up into the headroom.
const BASELINE = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Full 15-frame sequence — covers 2600ms (4 × 650ms text cycle) × 2.36 dot cycles
//
// Each frame: which message to show, dot Y offsets, dot opacities, and how to
// transition to the next frame.
//
//   holdMs  = AFTER_TIMEOUT delay (frame sits still this long before transitioning)
//   transMs = Smart Animate duration (0 = instant cut — used only for text swaps
//             or the final loop-back)
//
// Timeline summary:
//   t=0    msg0 shown, dots at rest
//   t=330  dot1 peak
//   t=480  dot2 peak
//   t=630  dot3 peak
//   t=650  INSTANT → msg1 (dots stay at dot3-peak)
//   t=980  dots settle to rest
//   t=1300 INSTANT → msg2 (dots mid-rise in new cycle)
//   t=1430 dot1 peak
//   t=1580 dot2 peak
//   t=1730 dot3 peak
//   t=1950 INSTANT → msg3 (dots nearly settled)
//   t=2080 dots at rest
//   t=2530 dot1 peak  (3rd dot cycle)
//   t=2600 INSTANT loop → back to frame 0 (dots snap to rest — imperceptible cut)
// ─────────────────────────────────────────────────────────────────────────────

interface FrameSpec {
  msgIdx:     number;
  dots:       [number, number, number];   // y offset from rest (0=rest, -8=peak)
  opacities:  [number, number, number];   // node opacity per dot
  holdMs:     number;
  transMs:    number;                     // 0 = instant cut
}

const SEQUENCE: FrameSpec[] = [
  // ── msg0: "Understanding your vision…" ──────────────────── t=0 → 650ms ──
  { msgIdx:0, dots:[   0,    0,    0], opacities:[.40,.40,.40], holdMs:  0, transMs:330 }, // t=0    rest
  { msgIdx:0, dots:[  -8, -4.6, -0.2], opacities:[1.0,.74,.41], holdMs:  0, transMs:150 }, // t=330  dot1↑
  { msgIdx:0, dots:[-4.6,   -8, -4.6], opacities:[.74,1.0,.74], holdMs:  0, transMs:150 }, // t=480  dot2↑
  { msgIdx:0, dots:[-0.2, -4.6,   -8], opacities:[.41,.74,1.0], holdMs: 20, transMs:  0 }, // t=630  dot3↑ → INSTANT text swap

  // ── msg1: "Analysing space requirements…" ──────────────── t=650 → 1300ms ──
  { msgIdx:1, dots:[-0.2, -4.6,   -8], opacities:[.41,.74,1.0], holdMs:  0, transMs:330 }, // t=650  dot3 falling
  { msgIdx:1, dots:[   0,    0,    0], opacities:[.40,.40,.40], holdMs:140, transMs:180 }, // t=980  rest (hold+trans = 320ms → t=1300)
  { msgIdx:1, dots:[-5.3, -0.4,    0], opacities:[.80,.43,.40], holdMs:  0, transMs:  0 }, // t=1300 mid-rise → INSTANT text swap

  // ── msg2: "AI matching availability & ratings…" ───────── t=1300 → 1950ms ──
  { msgIdx:2, dots:[-5.3, -0.4,    0], opacities:[.80,.43,.40], holdMs:  0, transMs:130 }, // t=1300 dot1 mid-rise
  { msgIdx:2, dots:[  -8, -4.6, -0.2], opacities:[1.0,.74,.41], holdMs:  0, transMs:150 }, // t=1430 dot1↑
  { msgIdx:2, dots:[-4.6,   -8, -4.6], opacities:[.74,1.0,.74], holdMs:  0, transMs:150 }, // t=1580 dot2↑
  { msgIdx:2, dots:[-0.2, -4.6,   -8], opacities:[.41,.74,1.0], holdMs:  0, transMs:220 }, // t=1730 dot3↑ → settles
  { msgIdx:2, dots:[   0,    0, -1.1], opacities:[.40,.40,.48], holdMs:  0, transMs:  0 }, // t=1950 nearly rest → INSTANT text swap

  // ── msg3: "Curating the best spaces for you…" ─────────── t=1950 → 2600ms ──
  { msgIdx:3, dots:[   0,    0, -1.1], opacities:[.40,.40,.48], holdMs:  0, transMs:130 }, // t=1950
  { msgIdx:3, dots:[   0,    0,    0], opacities:[.40,.40,.40], holdMs:120, transMs:330 }, // t=2080 rest (hold+trans = 450ms → t=2530)
  { msgIdx:3, dots:[  -8, -4.6, -0.2], opacities:[1.0,.74,.41], holdMs: 70, transMs:  0 }, // t=2530 dot1↑ → INSTANT loop back at t=2600
  // → loops to frame 0 (instant cut; dots snap to rest — barely perceptible at end of cycle)
];

function buildFrame(spec: FrameSpec, fontName: FontName): FrameNode {
  const container = figma.createFrame();
  container.name = 'thinking-state';
  container.layoutMode = 'HORIZONTAL';
  container.primaryAxisAlignItems = 'CENTER';
  container.counterAxisAlignItems = 'CENTER';
  container.itemSpacing = 10;
  container.paddingTop = 12;
  container.paddingBottom = 12;
  container.paddingLeft = 16;
  container.paddingRight = 16;
  container.fills = [{ type: 'SOLID', color: C.fafafa }];
  container.cornerRadius = 14;
  container.primaryAxisSizingMode = 'AUTO';
  container.counterAxisSizingMode = 'AUTO';

  // Dots wrapper — NONE layout so each dot can have its own Y position
  const dotsWrapper = figma.createFrame();
  dotsWrapper.name = 'thinking-dots';
  dotsWrapper.layoutMode = 'NONE';
  dotsWrapper.fills = [];
  dotsWrapper.resize(29, BASELINE + 7); // headroom above + 7px dot height

  for (let i = 0; i < 3; i++) {
    const dot = figma.createEllipse();
    dot.name = `t-dot-${i + 1}`;  // consistent name so Smart Animate tracks it across frames
    dot.resize(7, 7);
    dot.x = i * 11;                // 7px dot + 4px gap
    dot.y = BASELINE + spec.dots[i]; // negative offset = moves up
    dot.fills = [{ type: 'SOLID', color: C.gold }];
    dot.opacity = spec.opacities[i]; // node-level opacity — Smart Animate interpolates this
    dotsWrapper.appendChild(dot);
  }

  // Message text — changes per frame (instant text swap frames have same dots, different text)
  const text = figma.createText();
  text.name = 'thinkingMsg';
  text.fontName = fontName;
  text.fontSize = 13;
  text.fills = [{ type: 'SOLID', color: C.platinum }];
  text.characters = MESSAGES[spec.msgIdx];
  text.textAutoResize = 'WIDTH_AND_HEIGHT';

  container.appendChild(dotsWrapper);
  container.appendChild(text);
  return container;
}

const thinkingDiv: Script = {
  id: 'thinking-div',
  name: 'Thinking Div — Looping',
  description: 'Creates the AI processing state with dot-bounce + cycling text',

  async run() {
    let fontName: FontName;
    try {
      await figma.loadFontAsync({ family: 'Lato', style: 'Semi Bold' });
      fontName = { family: 'Lato', style: 'Semi Bold' };
    } catch {
      await figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' });
      fontName = { family: 'Inter', style: 'Semi Bold' };
    }

    const { x: cx, y: cy } = figma.viewport.center;
    const frames: FrameNode[] = [];

    for (let i = 0; i < SEQUENCE.length; i++) {
      const frame = buildFrame(SEQUENCE[i], fontName);
      frame.x = cx + i * (frame.width + 24);
      frame.y = cy;
      figma.currentPage.appendChild(frame);
      frames.push(frame);
    }

    // Wire reactions: each frame waits holdMs, then transitions to the next.
    // transMs=0 → instant cut (text swap or loop-back).
    for (let i = 0; i < frames.length; i++) {
      const spec = SEQUENCE[i];
      const next = frames[(i + 1) % frames.length];

      frames[i].reactions = [
        {
          trigger: {
            type: 'AFTER_TIMEOUT',
            timeout: Math.max(spec.holdMs / 1000, 0.001), // min 1ms to avoid API issues
          },
          actions: [
            {
              type: 'NODE',
              destinationId: next.id,
              navigation: 'NAVIGATE',
              transition: spec.transMs > 0
                ? {
                    type: 'SMART_ANIMATE',
                    easing: { type: 'EASE_IN_AND_OUT' },
                    duration: spec.transMs / 1000,
                  }
                : null,
              preserveScrollPosition: false,
            },
          ],
        },
      ];
    }

    figma.currentPage.selection = frames;
    figma.viewport.scrollAndZoomIntoView(frames);
    figma.notify('Done — 15 frames created. Start prototype from the first frame.');
  },
};

export default thinkingDiv;
