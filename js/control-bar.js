// Floating playback controls for in-page highlight mode (#16).
// Shown in the top frame once the player starts highlighting on this page,
// removed when playback stops. Lives in a closed shadow root attached to
// <html> (not <body>) so it neither picks up page CSS nor ends up in the text
// that html-doc.js / hover-overlay.js extract and scan.
var raControlBar = (function() {
  if (window !== window.top) return {show: function() {}, hide: function() {}}

  var SVG_NS = "http://www.w3.org/2000/svg"
  var POLL_MS = 700
  var STOP_GRACE_MS = 1500   // brief STOPPED blips between chunks must not hide the bar
  var host = null, root = null, btnPlay = null, btnPause = null, pollTimer = null, stoppedSince = 0, minimized = false,
    pending = false, generation = 0

  var ICONS = {
    rewind: "M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z",
    play: "M8 5v14l11-7z",
    pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
    stop: "M6 6h12v12H6z",
    forward: "M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z",
    minimize: "M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z",
    expand: "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
  }

  var CSS = [
    ":host { all: initial; }",
    ".wrap { position: fixed; left: 0; right: 0; bottom: 16px; display: flex; justify-content: center;",
    "  pointer-events: none; z-index: 2147483647; font: 14px/1 system-ui, sans-serif; }",
    ".wrap.min { justify-content: flex-end; padding-right: 16px; }",
    ".bar { pointer-events: auto; display: flex; gap: 2px; padding: 4px; border-radius: 24px;",
    "  background: #fff; color: #333; box-shadow: 0 2px 10px rgba(0,0,0,.3); }",
    "button { all: unset; box-sizing: border-box; width: 40px; height: 40px; border-radius: 50%;",
    "  display: flex; align-items: center; justify-content: center; cursor: pointer; color: inherit; }",
    "button:hover { background: rgba(0,0,0,.08); }",
    "button:focus-visible { outline: 2px solid #1a73e8; }",
    "svg { width: 24px; height: 24px; fill: currentColor; }",
    ".sep { width: 1px; margin: 8px 2px; background: currentColor; opacity: .25; }",
    ".min .full, .bar:not(.min) .mini { display: none; }",
    "[hidden] { display: none !important; }",
    "@media (prefers-color-scheme: dark) { .bar { background: #2b2b2b; color: #eee; }",
    "  button:hover { background: rgba(255,255,255,.12); } }",
  ].join("\n")

  function msg(key, fallback) {
    try { return brapi.i18n.getMessage(key) || fallback } catch (e) { return fallback }
  }

  function button(name, key, fallback, action, cls) {
    var b = document.createElement("button")
    b.type = "button"
    b.className = cls || "full"
    b.title = msg(key, fallback)
    b.setAttribute("aria-label", b.title)
    var svg = document.createElementNS(SVG_NS, "svg")
    svg.setAttribute("viewBox", "0 0 24 24")
    svg.setAttribute("aria-hidden", "true")
    var path = document.createElementNS(SVG_NS, "path")
    path.setAttribute("d", ICONS[name])
    svg.appendChild(path)
    b.appendChild(svg)
    b.addEventListener("click", function(e) {
      e.preventDefault()
      e.stopPropagation()
      action()
    })
    return b
  }

  function invoke(method) {
    return bgPageInvoke(method).catch(function(err) {
      console.warn("Spotlight Reader:", method, err)
      // extension context invalidated (reload/update) — nothing left to control
      if (/invalidated|dead object/i.test(String(err && err.message || err))) hide()
    })
  }

  function build() {
    // a bar left behind by a previous (reloaded/updated) instance of the add-on
    document.querySelectorAll("spotlight-reader-bar").forEach(function(el) { el.remove() })
    host = document.createElement("spotlight-reader-bar")
    host.setAttribute("data-spotlight-reader-bar", "")
    // inline !important beats page rules like `* { transform: ...; display: none !important }`,
    // which would hide the host or turn it into the containing block of the fixed bar.
    // The host itself is a zero-size box; the bar inside is position:fixed.
    var hostStyle = {display: "block", position: "fixed", inset: "0 auto auto 0", width: "0", height: "0",
      margin: "0", padding: "0", border: "0", background: "transparent", overflow: "visible",
      transform: "none", filter: "none", contain: "none", "will-change": "auto",
      visibility: "visible", opacity: "1", "pointer-events": "none"}
    for (var prop in hostStyle) host.style.setProperty(prop, hostStyle[prop], "important")
    root = host.attachShadow({mode: "closed"})
    var style = document.createElement("style")
    style.textContent = CSS
    var wrap = document.createElement("div")
    wrap.className = "wrap"
    var bar = document.createElement("div")
    bar.className = "bar"
    bar.setAttribute("role", "toolbar")
    wrap.appendChild(bar)
    root.append(style, wrap)
    bar.setAttribute("aria-label", "Spotlight Reader")
    bar.append(
      button("rewind", "bar_rewind", "Rewind", function() { invoke("rewind") }),
      btnPlay = button("play", "bar_play", "Play", function() { invoke("resume"); setPlaying(true) }),
      btnPause = button("pause", "bar_pause", "Pause", function() { invoke("pause"); setPlaying(false) }),
      button("stop", "bar_stop", "Stop", function() { invoke("stop"); hide() }),
      button("forward", "bar_forward", "Forward", function() { invoke("forward") }),
      sep(),
      button("minimize", "bar_minimize", "Minimize", function() { setMinimized(true) }),
      button("expand", "bar_expand", "Show playback controls", function() { setMinimized(false) }, "mini")
    )
    // keep page-level handlers (click-to-seek, hover preview, shortcuts) out of it
    ;["pointerdown", "pointerup", "mousedown", "mouseup", "click", "keydown"].forEach(function(type) {
      host.addEventListener(type, function(e) { e.stopPropagation() })
    })
    applyMinimized()
    setPlaying(true)
    // Top layer (popover) escapes transforms/filters on <html>/<body> (e.g. dark-mode
    // add-ons) and any page z-index; Firefox < 125 falls back to a plain fixed bar.
    var topLayer = typeof host.showPopover == "function"
    if (topLayer) host.setAttribute("popover", "manual")
    document.documentElement.appendChild(host)
    if (topLayer) try { host.showPopover() } catch (e) {}
  }

  function sep() {
    var s = document.createElement("span")
    s.className = "sep full"
    return s
  }

  function setPlaying(playing) {
    if (!root) return
    btnPlay.hidden = playing
    btnPause.hidden = !playing
  }

  function applyMinimized() {
    if (!root) return
    root.querySelector(".wrap").classList.toggle("min", minimized)
    root.querySelector(".bar").classList.toggle("min", minimized)
  }

  function setMinimized(value) {
    minimized = value
    applyMinimized()
    try { brapi.storage.local.set({controlBarMinimized: value}) } catch (e) {}
    var target = root && root.querySelector(value ? ".mini" : ".full:not([hidden])")
    if (target) target.focus()
  }

  async function poll() {
    var info
    try {
      info = await bgPageInvoke("getPlaybackState", [{peek: true}])
    } catch (e) {
      return hide()
    }
    if (!host) return
    var state = info && info.state
    if (state == "PLAYING" || state == "LOADING") { stoppedSince = 0; setPlaying(true) }
    else if (state == "PAUSED") { stoppedSince = 0; setPlaying(false) }
    else {
      if (!stoppedSince) stoppedSince = Date.now()
      else if (Date.now() - stoppedSince >= STOP_GRACE_MS) hide()
    }
  }

  function show() {
    stoppedSince = 0
    if (host && host.isConnected) return
    if (host) hide()
    if (pending) return
    pending = true
    var gen = generation
    // read the minimized state first, so a minimized bar doesn't flash up full
    readMinimized().then(function(value) {
      if (gen != generation || host) return
      pending = false
      minimized = value
      build()
      pollTimer = setInterval(poll, POLL_MS)
    })
  }

  function readMinimized() {
    try {
      return brapi.storage.local.get("controlBarMinimized")
        .then(function(s) { return !!(s && s.controlBarMinimized) }, function() { return false })
    } catch (e) {
      return Promise.resolve(false)
    }
  }

  function hide() {
    generation++
    pending = false
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    if (host) host.remove()
    host = root = btnPlay = btnPause = null
    stoppedSince = 0
  }

  return {show: show, hide: hide}
})();
