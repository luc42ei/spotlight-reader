#!/usr/bin/env python3
"""Headless probe for the in-page highlight pipeline (showHighlighting=3).

Loads a page in Chromium, injects the real content scripts (jquery,
sentence-splitter, html-doc, hover-overlay) with a stubbed extension API, then
replays a whole "playback" chunk by chunk exactly the way player.js does
(highlightBlock(originalTextIndex) + getPlaybackState polling) and reports for
every chunk: blue box element/size, amber overlay rects, scroll movement.

Usage:  python3 tools/hltest/hl_probe.py <url|file> [--max N] [--json out.json]
"""

import argparse, json, os, re, sys

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def chunker_source():
    """Extract speech.js's text breakers + the chunk loop into a standalone fn."""
    src = read("js", "speech.js")
    start = src.index("  //text breakers")
    end = src.rindex("}")  # closing brace of function Speech
    breakers = src[start:end]
    return (
        """
window.__raChunk = function(texts) {
%s
  var punctuator = new LatinPunctuator();
  var getChunks = function(text) { return new CharBreaker(200, punctuator).breakText(text); };
  texts = texts.slice();
  for (var i=0; i<texts.length; i++) if (/[\\w)]$/.test(texts[i])) texts[i] += '.';
  var chunks = [], chunkToOrig = [], chunkStart = [];
  for (var i=0; i<texts.length; i++) {
    var tc = getChunks(texts[i]);
    var off = 0;
    for (var j=0; j<tc.length; j++) {
      if (/[\\p{L}\\p{N}]/u.test(tc[j])) { chunks.push(tc[j]); chunkToOrig.push(i); chunkStart.push(off); }
      off += tc[j].length;
    }
  }
  return {chunks: chunks, chunkToOrig: chunkToOrig, chunkStart: chunkStart, texts: texts};
};
"""
        % breakers
    )


STUB = """
window.__raFakeState = {state: 'STOPPED'};
window.brapi = {
  storage: {local: {
    get: function(k, cb) { var v = {showHighlighting: 3}; if (cb) cb(v); return Promise.resolve(v); },
    onChanged: {addListener: function(){}}
  }},
  runtime: {
    sendMessage: function(msg) {
      if (msg && msg.method === 'getPlaybackState') return Promise.resolve(window.__raFakeState);
      return Promise.resolve(null);
    },
    getURL: function(p) { return p; }
  }
};
var paragraphSplitter = /(?:\\s*\\r?\\n\\s*){2,}/;
function getInnerText(elem) { var t = elem.innerText; return t ? t.trim() : ""; }
function isNotEmpty(text) { return text; }
const getMath = function() { return Promise.resolve(null); };
"""

PROBE = """
window.__raProbe = function(chunkIdx, origIdx, chunkStart, chunks) {
  window.__raFakeState = {
    state: 'PLAYING',
    speechInfo: {texts: chunks, position: {index: chunkIdx, originalTextIndex: origIdx, chunkStart: chunkStart}}
  };
  readAloudDoc.highlightBlock(origIdx);
};

window.__raReport = function() {
  var box = document.querySelector('.read-aloud-highlight') || document.querySelector('read-aloud-hl');
  var r = box ? box.getBoundingClientRect() : null;
  var svg = document.querySelector('svg[data-ra-play], svg');
  var rects = [];
  document.querySelectorAll('svg').forEach(function(s) {
    if (Number(getComputedStyle(s.parentNode).zIndex) === 2147483644) {
      s.querySelectorAll('rect').forEach(function(x) {
        rects.push({x: +x.getAttribute('x'), y: +x.getAttribute('y'), w: +x.getAttribute('width'), h: +x.getAttribute('height')});
      });
    }
  });
  // Pages that lock <html> at overflow:hidden scroll an inner container instead,
  // so window.scrollY stays 0 there — measure whatever actually scrolls the box.
  var view = window.raScrollView ? window.raScrollView(box) : {scroller: window};
  var scTop = Math.round(view.scroller === window ? window.scrollY : view.scroller.scrollTop);
  return {
    scroller: view.scroller === window ? 'window' : view.scroller.tagName,
    boxTag: box ? box.tagName : null,
    boxClass: box ? (box.className && box.className.toString ? box.className.toString().slice(0,60) : '') : null,
    boxes: document.querySelectorAll('.read-aloud-highlight, read-aloud-hl').length,
    boxTop: r ? Math.round(r.top + scTop) : null,
    boxH: r ? Math.round(r.height) : null,
    boxText: box ? (box.innerText || '').replace(/\\s+/g,' ').trim().slice(0,80) : null,
    boxTextLen: box ? (box.innerText || '').trim().length : 0,
    amber: rects.length,
    amberTop: rects.length ? Math.round(rects[0].y) : null,
    scrollY: scTop
  };
};
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--max", type=int, default=0, help="stop after N chunks")
    ap.add_argument("--json", default="")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--browser", default="firefox", choices=["firefox", "chromium"],
                    help="Gecko is the shipping target, so it is the default")
    ap.add_argument("--htmldoc", default="", help="alternative html-doc.js (e.g. baseline from git)")
    ap.add_argument("--wait", type=int, default=800, help="ms to wait per chunk for the overlay poll")
    args = ap.parse_args()

    url = args.target
    if os.path.exists(url):
        url = "file://" + os.path.abspath(url)

    with sync_playwright() as p:
        browser = getattr(p, args.browser).launch(headless=not args.headed)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.on("console", lambda m: print("  [console:%s] %s" % (m.type, m.text)))
        page.on("pageerror", lambda e: print("  [pageerror] %s" % e))
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass
        page.wait_for_timeout(1500)

        for f in ("js/jquery-3.7.1.min.js", "js/sentence-splitter.js"):
            page.add_script_tag(content=read(*f.split("/")))
        page.add_script_tag(content=STUB)
        page.add_script_tag(content=chunker_source())
        if args.htmldoc:
            with open(args.htmldoc, encoding="utf-8") as f:
                page.add_script_tag(content=f.read())
        else:
            page.add_script_tag(content=read("js", "content", "html-doc.js"))
        page.add_script_tag(content=read("js", "content", "hover-overlay.js"))
        page.add_script_tag(content=PROBE)
        page.wait_for_timeout(500)

        texts = page.evaluate("readAloudDoc.getTexts(0)")
        ch = page.evaluate("window.__raChunk(%s)" % json.dumps(texts))
        chunks = ch["chunks"]
        print("texts=%d chunks=%d" % (len(texts), len(chunks)))

        n = len(chunks) if not args.max else min(len(chunks), args.max)
        rows = []
        prev_scroll = 0
        for i in range(n):
            page.evaluate(
                "([i,o,cs,ch]) => window.__raProbe(i,o,cs,ch)",
                [i, ch["chunkToOrig"][i], ch["chunkStart"][i], chunks],
            )
            page.wait_for_timeout(args.wait)
            rep = page.evaluate("window.__raReport()")
            rep["chunk"] = i
            rep["orig"] = ch["chunkToOrig"][i]
            rep["text"] = chunks[i].replace("\n", " ")[:70]
            rep["scrollDelta"] = rep["scrollY"] - prev_scroll
            prev_scroll = rep["scrollY"]
            rows.append(rep)
            flags = []
            if not rep["boxTag"]:
                flags.append("NO-BOX")
            if rep["boxes"] > 1:
                flags.append("MULTI-BOX=%d" % rep["boxes"])
            if rep["boxTextLen"] > max(300, len(texts[ch["chunkToOrig"][i]]) * 2):
                flags.append("HUGE-BOX(%d chars)" % rep["boxTextLen"])
            if rep["scrollDelta"] < -100:
                flags.append("SCROLL-BACK %d" % rep["scrollDelta"])
            if not rep["amber"]:
                flags.append("NO-AMBER")
            print(
                "#%-4d orig=%-4d box=%-12s h=%-5s amber=%-3s scroll=%-6s %s | %s"
                % (
                    i, rep["orig"], rep["boxTag"], rep["boxH"], rep["amber"],
                    rep["scrollY"], ("!! " + ", ".join(flags)) if flags else "ok",
                    rep["text"],
                )
            )

        if args.json:
            with open(args.json, "w", encoding="utf-8") as f:
                json.dump({"texts": texts, "chunks": chunks, "rows": rows}, f, indent=1)
        browser.close()


if __name__ == "__main__":
    main()
