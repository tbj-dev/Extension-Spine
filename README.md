# Spine Viewer (SillyTavern Extension)

Early MVP scaffold. This extension renders Spine skeletons using PixiJS + pixi-spine.

Setup
- In ST, install this extension folder (third-party).
- Open Settings → Extensions → Spine Viewer, toggle Enabled.
- Put your spine files under `/data/<user-handle>/assets/spine`:

```js
extension_settings["Extension-Spine"].characterModelMapping = {
  // Seraphina must be the character name in the current chat
  "Seraphina": {
    // You can use either JSON or SKEL (binary) skeletons
    // For JSON:
    jsonUrl: "/assets/spine/raptor-pro/raptor-pro.json",
    // Or for SKEL:
    // skeletonUrl: "/assets/spine/raptor-pro/raptor-pro.skel",
    atlasUrl: "/assets/spine/raptor-pro/raptor-pro.atlas"
  }
};
```

Notes
- Supports Spine skeletons in JSON and SKEL (binary) formats. Provide either jsonUrl or skeletonUrl in settings.
- This is a basic MVP. It creates a PIXI.Application per character and attaches it to `#visual-novel-wrapper` (or `#expression-wrapper` fallback).
- Z-order and positioning are minimal; per-character zIndex can be tweaked in `characterModelsSettings`.
- For models with multiple textures, ensure the atlas references resolve relative to the atlas file URL.
- Spine runtimes and assets may have licensing constraints; ensure compliance.


