export type ScrollRoot = HTMLElement | Window;

export function scrollRoot(element: HTMLElement): ScrollRoot {
  let parent: HTMLElement | null = element;
  while (parent) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
    parent = parent.parentElement;
  }
  return window;
}

export function viewport(root: ScrollRoot) {
  return root === window ? { top: 0, height: window.innerHeight }
    : { top: (root as HTMLElement).getBoundingClientRect().top + (root as HTMLElement).clientTop, height: (root as HTMLElement).clientHeight };
}

export function scrollBy(root: ScrollRoot, delta: number) {
  if (root === window) window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
  else (root as HTMLElement).scrollTop += delta;
}

export function scrollToTop(root: ScrollRoot) {
  if (root === window) window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  else (root as HTMLElement).scrollTop = 0;
}
