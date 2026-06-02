// scrollfix.js — fixes diffx's scroll-jump (wong2/diffx issue #24).
//
// Diagnosis (exhaustive in-page instrumentation, incl. a pre-load trap wrapping
// scroll APIs before diffx loads): the jump is a real documentElement scroll
// change with NO JavaScript cause (scrollTo/By/IntoView/scrollTop=/focus/hash/
// window.scroll all silent; scrollHeight constant; no scroll-snap). It's the
// browser engine's native scroll reaction to diffx's DOM churn — unblockable at
// the source — so we revert it after the fact.
//
// Signature measured from real reproductions:
//   * normal wheel/trackpad scroll: small steps (<=~450px) fired 3-15ms after a
//     wheel event (sinceWheel small).
//   * the JUMP: a large backward (upward) delta (700-3500px) that arrives
//     100-250ms AFTER the last wheel tick (async, not a direct wheel response).
//
// Fix (direction-agnostic — wheel sign is unreliable in this webview): revert a
// backward scroll that is either very large, or moderately large AND arrives
// well after the last wheel tick. Normal scrolling and genuine upward scrolling
// stay untouched. Re-entrancy guarded.
(function () {
  if (window.__cmuxScrollFix) return;
  window.__cmuxScrollFix = true;

  var BIG = 550;        // px: a single backward delta this large is never a normal tick → revert
  var MED = 300;        // px: revert if this big AND clearly after the wheel burst
  var ASYNC = 80;       // ms after last wheel for the MED rule to apply

  var lastY = window.scrollY;
  var lastWheelT = 0;
  var fixing = false;

  window.addEventListener('wheel', function () { lastWheelT = Date.now(); }, { passive: true, capture: true });
  window.addEventListener('touchmove', function () { lastWheelT = Date.now(); }, { passive: true, capture: true });

  window.addEventListener('scroll', function () {
    if (fixing) { lastY = window.scrollY; return; }
    var y = window.scrollY, dy = y - lastY;
    var sinceWheel = Date.now() - lastWheelT;
    var isJump = dy < -BIG || (dy < -MED && sinceWheel > ASYNC);
    if (isJump) {
      fixing = true;
      window.scrollTo(0, lastY);   // snap back to pre-jump position
      fixing = false;
      return;                       // keep lastY (we reverted)
    }
    lastY = y;
  }, { passive: true, capture: true });
})();
