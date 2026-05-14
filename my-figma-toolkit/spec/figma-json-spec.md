# Figma Import JSON Spec (v1)

This document is the **contract** between:
- Anything that *generates* a Figma design (Claude Code reading HTML, hand-authored JSON, another AI)
- The plugin's `Import Design from JSON` script that *builds* the Figma file

If you're writing this JSON, follow the schema exactly. Unknown fields are ignored. Required fields cause errors.

---

## Top-level shape

```jsonc
{
  "meta": {
    "version": 1,
    "platform": "mobile" | "tablet" | "desktop" | "web",
    "source": "html-to-figma" | "hand" | "..."   // free-form attribution
  },
  "tokens": {
    "colors": {
      "<name>": "#RRGGBB" | "#RRGGBBAA" | "rgba(r,g,b,a)"
    },
    "fonts": [
      { "family": "DM Sans", "styles": ["Regular", "Medium", "Bold"] }
    ],
    "textStyles": {                                // optional, named reusable text style
      "<name>": {
        "family": "DM Sans",
        "style": "Medium",
        "size": 13,
        "lineHeight": 1.4,                         // number = multiplier; "20px" = absolute; "AUTO" allowed
        "letterSpacing": -0.2,                     // px (or "0.5%" for percentage)
        "textCase": "ORIGINAL" | "UPPER" | "LOWER" | "TITLE",
        "textDecoration": "NONE" | "UNDERLINE" | "STRIKETHROUGH"
      }
    }
  },
  "components": [                                  // optional reusable components
    { "name": "btn-primary", "node": <NodeSpec> }
  ],
  "screens": [                                     // top-level frames laid out side-by-side
    {
      "name": "Splash",
      "size": [375, 812],
      "background": "<color>",                     // hex, rgba, or token name
      "children": [<NodeSpec>, ...]
    }
  ]
}
```

A screen is just a top-level frame placed at `(x=0..N*width, y=0)` on the Figma page so they read left-to-right.

---

## NodeSpec — every visual element

```jsonc
{
  "type": "frame" | "rectangle" | "ellipse" | "line" | "text" | "vector" | "group" | "image" | "instance",
  "name": "Layer name (optional, used as Figma layer name)",

  // Positioning — pick ONE strategy per parent
  "position": { "x": 0, "y": 0 },                  // absolute, relative to parent frame
  "size": [width, height],                         // pixels; text auto-sizes if omitted

  // Visual properties (most types accept these)
  "fill": "<color | gradient | image>",
  "stroke": { "color": "<color>", "weight": 1, "align": "INSIDE" | "OUTSIDE" | "CENTER" },
  "cornerRadius": 12,                              // number (uniform) OR [tl, tr, br, bl]
  "opacity": 1,
  "rotation": 0,                                   // degrees, positive = CCW
  "shadow": "<x> <y> <blur> <color>",              // CSS-like shorthand; or [{ type, x, y, blur, spread, color }]
  "blendMode": "NORMAL" | "MULTIPLY" | "SCREEN" | ...,
  "visible": true,
  "clipsContent": true,                            // frame-only; default true

  // Auto-layout (frame-only) — if present, children flow automatically and "position" inside is ignored
  "autoLayout": {
    "direction": "row" | "column",
    "gap": 8,
    "padding": "16" | "16 24" | "16 24 16 24",     // CSS-like
    "alignItems": "start" | "center" | "end" | "stretch",
    "justifyContent": "start" | "center" | "end" | "between",
    "wrap": false
  },

  // Children (frame, group only)
  "children": [<NodeSpec>, ...],

  // Type-specific fields below
}
```

### type: `text`

```jsonc
{
  "type": "text",
  "text": "The actual text content",
  "textStyle": "h1"                                // OR inline object:
  "textStyle": {
    "family": "DM Sans", "style": "Medium", "size": 13,
    "lineHeight": 1.4, "letterSpacing": -0.2,
    "textCase": "UPPER", "textDecoration": "UNDERLINE"
  },
  "color": "#0B2E26" | "ink",                      // hex or token name
  "align": "left" | "center" | "right" | "justify",
  "verticalAlign": "top" | "center" | "bottom",
  "autoResize": "WIDTH_AND_HEIGHT" | "HEIGHT" | "NONE"
}
```

### type: `rectangle`, `ellipse`

Just shapes. Use `size`, `fill`, `stroke`, `cornerRadius`.

### type: `line`

```jsonc
{
  "type": "line",
  "position": { "x": 0, "y": 0 },
  "size": [length, 1],                             // height is always treated as stroke thickness
  "stroke": { "color": "#888", "weight": 1, "dashes": [4, 4] }  // dashes optional
}
```

### type: `vector` (SVG icons, illustrations)

```jsonc
{
  "type": "vector",
  "name": "icon-clock",
  "position": { "x": 0, "y": 0 },
  "size": [24, 24],
  "viewBox": [0, 0, 24, 24],                       // SVG viewBox; defaults to [0,0,size[0],size[1]]
  "paths": [
    {
      "d": "M12 6V12L16 14",                       // SVG path data
      "fill": "none" | "<color>",
      "stroke": "<color>",
      "strokeWidth": 1.5,
      "strokeLinecap": "round" | "butt" | "square",
      "strokeLinejoin": "round" | "miter" | "bevel",
      "windingRule": "NONZERO" | "EVENODD"         // default NONZERO
    }
  ]
}
```

**Note:** Plain SVG `<circle>`, `<rect>`, `<line>`, `<polygon>` can be converted to path data OR represented as native Figma primitives (`ellipse`, `rectangle`, `line`) inside a parent `group`. The plugin handles either. Use whichever is easier to produce.

### type: `group`

```jsonc
{
  "type": "group",
  "name": "Icon",
  "position": { "x": 0, "y": 0 },
  "children": [<NodeSpec>, ...]
}
```

A group has no own visual properties — it's just a wrapper for transform/visibility.

### type: `image`

```jsonc
{
  "type": "image",
  "position": { "x": 0, "y": 0 },
  "size": [w, h],
  "image": { "data": "<base64-encoded bytes>", "scaleMode": "FILL" | "FIT" | "CROP" | "TILE" }
}
```

For now images must be inline base64. Future: support URLs that we fetch.

### type: `instance`

```jsonc
{
  "type": "instance",
  "component": "btn-primary",                      // refers to components[].name
  "position": { "x": 0, "y": 0 },
  "overrides": {                                   // optional
    "<sub-node-name>": { "text": "Sign In", "color": "#FFFFFF" }
  }
}
```

---

## Colors

A color value can be:
- Hex: `"#FFFFFF"`, `"#FFFFFFAA"` (with alpha)
- rgba: `"rgba(255, 255, 255, 0.8)"`
- Token reference: `"primary"`, `"teal-900"` — must be defined in `tokens.colors`

## Gradient fills

```jsonc
"fill": {
  "type": "linear-gradient",
  "from": [0, 0],                                  // unit vector relative to node (0..1)
  "to": [0, 1],
  "stops": [
    { "position": 0,   "color": "transparent" },
    { "position": 0.5, "color": "rgba(29,158,117,0.4)" },
    { "position": 1,   "color": "transparent" }
  ]
}
```

Also `"radial-gradient"`, `"angular-gradient"` with the same shape (Figma supports them but pure linear is enough for most HTML conversions).

## Effects (shadows, blurs)

CSS shorthand string (simple case):
```jsonc
"shadow": "0 0 24 rgba(16,25,40,0.08)"             // x y blur color
"shadow": "0 4 12 2 rgba(0,0,0,0.1)"               // x y blur spread color
```

Or array form (multiple shadows or other effects):
```jsonc
"effects": [
  { "type": "drop-shadow", "x": 0, "y": 4, "blur": 12, "spread": 0, "color": "rgba(0,0,0,0.1)" },
  { "type": "layer-blur", "radius": 4 },
  { "type": "background-blur", "radius": 20 }
]
```

---

## Example: minimal screen

```jsonc
{
  "meta": { "version": 1, "platform": "mobile" },
  "tokens": {
    "colors": { "teal-900": "#0B2E26", "white": "#FFFFFF" },
    "fonts": [{ "family": "DM Sans", "styles": ["Medium"] }]
  },
  "screens": [
    {
      "name": "Hello",
      "size": [375, 812],
      "background": "teal-900",
      "children": [
        {
          "type": "text",
          "position": { "x": 24, "y": 100 },
          "text": "Hello world",
          "textStyle": { "family": "DM Sans", "style": "Medium", "size": 32 },
          "color": "white"
        }
      ]
    }
  ]
}
```

---

## Conventions / rules of thumb

1. **Coordinates are relative to the immediate parent.** Top-left origin.
2. **Sizes are in CSS-style pixels** (Figma points). A `375` width = a 375pt Figma frame.
3. **Layout strategy is parent-scoped.** A frame with `autoLayout` makes its children auto-flow; `position` on those children is ignored. A frame without `autoLayout` uses absolute positioning.
4. **Color tokens are flat.** Use `kebab-case`. Reference them anywhere a color is expected.
5. **Vector node sizes determine the rendered size.** The `viewBox` defines the coordinate system the path data lives in; Figma scales it to fit `size`.
6. **Be specific about position.** Don't omit `position` unless inside an auto-layout parent.
7. **Component definitions go in `components[]`, not inline.** Reference them with `type: "instance", "component": "name"`.
