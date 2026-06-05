// scrollfix.js — fixes the cmux-webview diff scroll-jump (wong2/diffx #24, and
// the same class in @pierre/diffs) WITHOUT fighting the user.
//
// Diagnosis: diff viewers correct row heights asynchronously after render; when
// content above the viewport changes height, the browser shifts documentElement
// scroll under you (no JS cause — it's the engine's native reaction to DOM
// churn). We revert that shift after the fact.
//
// The jump's signature: a backward (upward) delta that arrives ~100-250ms AFTER
// the last user input (async), while the document is GROWING. So we revert only
// backward shifts that are (a) not user-driven and (b) not a legit document
// shrink. Specifically:
//   * user-driven scrolls (any wheel/touch/key within ASYNC ms) are NEVER
//     reverted — scrollfix must never fight a scroll you're making.
//   * when the document SHRINKS (you collapsed a file), accept the new clamped
//     position instead of reverting — fixes "stuck at the bottom after
//     collapsing the last file."
//   * lastY is never held past the end of the document (de-stale on resize).
(function () {
  if (window.__cmuxScrollFix) return;
  window.__cmuxScrollFix = true;

  var MED = 300;     // px: minimum backward shift to treat as a jump
  var ASYNC = 80;    // ms since last user input before a backward shift counts as async

  var doc = document.documentElement;
  var lastY = window.scrollY;
  var lastH = doc.scrollHeight;
  var lastInputT = 0;
  var fixing = false;

  function input() { lastInputT = Date.now(); }
  window.addEventListener('wheel', input, { passive: true, capture: true });
  window.addEventListener('touchmove', input, { passive: true, capture: true });
  window.addEventListener('keydown', input, { passive: true, capture: true });

  window.addEventListener('scroll', function () {
    if (fixing) { lastY = window.scrollY; return; }
    var y = window.scrollY;
    var h = doc.scrollHeight;
    var maxY = Math.max(0, h - window.innerHeight);
    if (h < lastH) {                       // document shrank (a file collapsed) — accept it
      lastH = h; lastY = Math.min(y, maxY); return;
    }
    lastH = h;
    if (lastY > maxY) lastY = maxY;        // never hold a stale position past the end
    var dy = y - lastY;
    var jump = (Date.now() - lastInputT > ASYNC) && (dy < -MED);
    if (jump) {
      fixing = true;
      window.scrollTo(0, lastY);           // revert the async backward shift
      fixing = false;
      return;
    }
    lastY = y;
  }, { passive: true, capture: true });
})();
