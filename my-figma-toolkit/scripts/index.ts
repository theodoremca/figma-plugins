// ======================================
// SCRIPT REGISTRY
// To add a new script:
//   1. Create a new file in scripts/ (copy square-to-circle.ts as a template)
//   2. Import it below
//   3. Add it to the `scripts` array
//   4. Rebuild (npm run build) and reload the plugin in Figma
// ======================================

import { Script } from './types';
import squareToCircle from './square-to-circle';
import thinkingDiv from './thinking-div';
import screenToJson from './screen-to-json';

export const scripts: Script[] = [
  squareToCircle,
  thinkingDiv,
  screenToJson,
  // Add new scripts here:
  // import myNewScript from './my-new-script';
  // myNewScript,
];
