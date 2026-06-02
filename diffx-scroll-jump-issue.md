# Bug report: page scroll jumps when scrolling within/past long files (virtualization, no scroll anchoring)

**Repo:** wong2/diffx · **Version:** 0.12.1 (latest) · **OS:** macOS 15 · cmux embedded browser (Chromium/WebKit-class webview)

## Summary

While scrolling a diff, the page **jumps** (scroll position shifts backward/forward), most noticeably around the **bottom of a file / file boundaries**. It happens with both the trackpad/wheel and the arrow keys, and in both `split` and `unified` views.

## Steps to reproduce

1. `diffx` on any repo whose diff is tall enough to scroll several viewports (e.g. a few files of a few hundred lines).
2. Scroll down steadily with a trackpad (or hold ↓ / PageDown).
3. As a file's rows scroll in/out near the viewport edge, the page position jumps.

## Root cause (from reading `dist/client/assets/index-*.js`)

The per-file virtualizer (`little-virtualized-file-diff`) renders with **zero overscan** — `bufferBefore: 0, bufferAfter: 0` — so rows mount/unmount right at the viewport edge. On mount, a `ResizeObserver` (`handleResizeObserver` → `reconcileHeights()` → `computeApproximateSize()`) measures real row heights and rewrites a placeholder height:

```js
this.placeHolder.style.setProperty('height', `${e}px`)
```

When that correction changes the height of content **above the viewport**, the document above the user grows/shrinks and the scroll position shifts under them — the jump. There is **no scroll anchoring** to compensate: `overflow-anchor` appears 0 times in the bundle and CSS.

This is the classic dynamic-height-virtualization scroll-jump (cf. react-virtualized #842, TanStack/virtual #659).

Notes that localize it:
- diffx registers **no arrow-key scroll handler**, so arrow keys do plain native scrolling — same code path as the wheel, which is why both jump. (Rules out a custom key handler.)
- Programmatic `scrollTo`/`scrollBy` never jump (they don't race the ResizeObserver height correction), so it only manifests under real continuous user input.

## Suggested fixes (in rough order)

1. **Add scroll anchoring.** `overflow-anchor: auto` on the scroll container, and avoid `overflow-anchor: none`. Lets the browser pin position across above-viewport height changes — cheapest mitigation.
2. **Add overscan / buffers.** Non-zero `bufferBefore`/`bufferAfter` so rows mount before they're at the very edge, and reserve estimated height so corrections are smaller and off-viewport.
3. **Anchor-correct on resize.** When `reconcileHeights()` changes the height of content above the current scrollTop, compensate by adjusting `scrollTop` by the same delta (standard "maintain visual position" pattern).
4. **Option to disable virtualization** for small/medium diffs (render fully, real heights, nothing to re-estimate).

Happy to test a patch — I can reproduce reliably with trackpad/arrow scrolling.
```
```
