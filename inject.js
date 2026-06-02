// Injected into the diffx page via `cmux browser addscript` / `addinitscript`.
// Adds a floating "Send to agent" button that pushes diffx comments into the
// cmux agent pane through the bridge. Self-guards against double-sends.
(function () {
  var BRIDGE = 'http://127.0.0.1:3434';
  function mount() {
    if (document.getElementById('cmux-send')) return;
    if (!document.body) return addEventListener('DOMContentLoaded', mount);
    var b = document.createElement('button');
    b.id = 'cmux-send';
    b.textContent = '▶ Send to agent';
    b.style.cssText =
      'position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:10px 14px;border:none;' +
      'border-radius:8px;background:#2f81f7;color:#fff;font:600 13px system-ui;cursor:pointer;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.35)';
    var s = document.createElement('div');
    s.id = 'cmux-send-status';
    s.style.cssText =
      'position:fixed;z-index:2147483647;right:16px;bottom:56px;font:12px system-ui;' +
      'color:#9aa;background:rgba(0,0,0,.4);padding:2px 6px;border-radius:4px;display:none';
    b.onclick = async function () {
      if (b.disabled) return;                 // guard: ignore rapid double-clicks
      b.disabled = true; b.style.opacity = .6;
      s.style.display = 'block'; s.textContent = 'sending…';
      try {
        var j = await (await fetch(BRIDGE + '/push', { method: 'POST' })).json();
        s.textContent = j.error ? ('error: ' + j.error)
          : j.busy ? 'already sending…'
          : j.sent ? ('sent ' + j.sent + ' to agent ✓')
          : 'no comments to send';
      } catch (e) { s.textContent = 'bridge offline: ' + e.message; }
      setTimeout(function () { b.disabled = false; b.style.opacity = 1; }, 1500);
    };
    document.body.appendChild(b);
    document.body.appendChild(s);
  }
  mount();
})();
