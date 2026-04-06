import { Script } from './types';

const squareToCircle: Script = {
  id: 'square-to-circle',
  name: 'Square to Circle',
  description: 'Converts selected rectangles into ellipses (circles)',
  run() {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.notify('Select at least one rectangle first.');
      return;
    }

    let converted = 0;
    const newSelection: SceneNode[] = [];

    for (const node of selection) {
      if (node.type === 'RECTANGLE') {
        const ellipse = figma.createEllipse();
        ellipse.x = node.x;
        ellipse.y = node.y;
        ellipse.resize(node.width, node.height);

        // Copy visual properties
        ellipse.fills = JSON.parse(JSON.stringify(node.fills));
        ellipse.strokes = JSON.parse(JSON.stringify(node.strokes));
        ellipse.strokeWeight = node.strokeWeight;
        ellipse.opacity = node.opacity;
        ellipse.name = node.name + ' (circle)';

        // Insert in the same parent at the same position
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
  },
};

export default squareToCircle;
