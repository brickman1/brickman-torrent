// Tiny DOM helper: no framework, explicit elements.

export type Child = Node | string | number | null | undefined | false;

type Attrs = Record<string, unknown>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

function applyAttrs(node: HTMLElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    switch (key) {
      case 'class':
        node.className = String(value);
        break;
      case 'text':
        node.textContent = String(value);
        break;
      case 'html':
        node.innerHTML = String(value);
        break;
      case 'dataset':
        Object.assign(node.dataset, value as Record<string, string>);
        break;
      case 'style':
        node.setAttribute('style', String(value));
        break;
      default:
        if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
    }
  }
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'object') parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fragment(children: Child[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  append(frag, children);
  return frag;
}
