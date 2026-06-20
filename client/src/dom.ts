/**
 * The page's global reset (`*, html, body { width:100%; height:100% }` in
 * index.html) forces every element — including DOM-overlay UI we inject — to fill
 * the viewport. Tagging an overlay root with the `comet-ui` class re-establishes
 * content-driven sizing for that subtree so inline width/height take effect.
 */
export function cometUiClass(): string {
  if (!document.getElementById('comet-ui-reset')) {
    const style = document.createElement('style');
    style.id = 'comet-ui-reset';
    style.textContent = '.comet-ui, .comet-ui * { width: auto; height: auto; box-sizing: border-box; }';
    document.head.appendChild(style);
  }
  return 'comet-ui';
}
