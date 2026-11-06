// Spotlight Reader — sentence hover + click overlay + playback highlight
//
// Three layers:
//
//   1. HOVER PREVIEW (purple, z:2147483646)
//      mousemove (32 ms throttle) → blockFromPoint → charOffsetInBlock →
//      sentenceAtOffset → createRangeForChars → getClientRects →
//      per-line SVG <rect rx=3>
//
//   2. CLICK-TO-SEEK
//      pointerup → same pipeline → window.__raSeekTarget = {el, sentenceText}
//      → brapi stop → brapi playTab   (html-doc.js consumes __raSeekTarget)
//
//   3. PLAYBACK HIGHLIGHT (amber, z:2147483644)
//      setInterval 300 ms → getPlaybackState → texts[position.index] →
//      findTextInScope (anchored to the _highlightEntries element the chunk
//      came from + the occurrence derived from position.chunkStart, falling
//      back to the page-wide cursor search) →
//      createRangeForChars → per-line SVG <rect rx=3>
//      Stored Range repositions on scroll.
//      Auto-scrolls block into view when it leaves the viewport.

(function () {
  'use strict';

  if (window.__raHoverOverlayActive) return;

  // ── CONSTANTS ──────────────────────────────────────────────────────────────

  const HOVER_MS     = 32;          // mousemove throttle ~30 fps
  const POLL_MS      = 300;         // playback state poll interval
  const MIN_TEXT     = 12;          // min chars for a block to be readable
  const HOVER_COLOR  = '#6c63ff';   // purple  — hover preview
  const HOVER_ALPHA  = '0.18';
  const PLAY_COLOR   = '#f5a623';   // amber   — active playback sentence
  const PLAY_ALPHA   = '0.35';
  const PLAY_ALPHA_DARK = '0.2';  // light text on a dark page — 0.35 glares there

  const INTERACTIVE  = 'a,button,input,select,textarea,[contenteditable],[role="button"],[role="link"]';

  // ── STATE ──────────────────────────────────────────────────────────────────

  let blocks    = [];
  let blockMap  = new Map();      // el → index  (O(1) hit-test)
  let sentCache = new WeakMap();  // el → [{text, start, end}]

  // Hover SVG (purple, above playback layer)
  let hovWrap = null, hovSvg = null, hovTimer = 0;

  // Playback SVG (amber, below hover layer)
  let actWrap = null, actSvg = null;
  let actRange  = null;   // stored so scroll can repaint without waiting for poll
  let actAlpha  = PLAY_ALPHA;
  let pollTimer = null;
  let lastPlayKey = '';   // "index:text" — skip repaint when unchanged
  // Forward search cursor — lets a repeated sentence highlight the CURRENT
  // occurrence instead of always the first one in the document.
  let cursorBlock = null; // element of the last matched block (survives rescans)
  let cursorChar  = 0;    // char offset just past the last match within cursorBlock
  let lastTextIdx = -1;   // previous position.index — a drop signals seek-back/restart
  let pollActive = false;
  let clearDebounceTimer = null;
  let readerActive = false;   // true while reader is PLAYING or PAUSED — gates hover & click
  let domObserver = null;     // lifted to module scope so scanBlocks can pause it while it mutates the DOM

  // ── SENTENCE SPLITTING ─────────────────────────────────────────────────────

  // Delegates to the shared splitter (js/sentence-splitter.js, injected before
  // this file) — the same boundaries the TTS chunker uses, so hover/seek
  // sentences match the spoken chunks.
  function splitSentences(text) {
    if (!text) return [];
    if (typeof raSentenceSplitter !== 'undefined')
      return raSentenceSplitter.splitWithOffsets(text);
    return [{ text: text.trim(), start: 0, end: text.length }];
  }

  // Concatenate the block's text (same offset space as createRangeForChars: text nodes
  // in document order) and record offsets where a <br> sits. Legacy pages drop several
  // paragraphs into one block separated only by <br>, which textContent omits — without
  // these breaks splitSentences merges a sentence across the paragraph gap.
  function blockTextWithBreaks(el) {
    let text = '';
    const breaks = [];
    (function rec(node) {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { text += c.textContent; continue; }
        if (c.nodeType !== 1) continue;
        if (c.tagName === 'BR') { breaks.push(text.length); continue; }
        // A nested block-level element is a paragraph boundary that textContent
        // omits (e.g. real <p>s inside a display:contents wrapper that scanBlocks
        // swallowed into one synthetic block). Record a break before and after its
        // text so no sentence runs across it. display:contents has no box of its
        // own — skip its break but still recurse so ITS block children count.
        let disp = '';
        try { disp = getComputedStyle(c).display; } catch (_) {}
        const breaking = disp && disp.indexOf('inline') !== 0 && disp !== 'contents';
        if (breaking) breaks.push(text.length);
        rec(c);
        if (breaking) breaks.push(text.length);
      }
    })(el);
    return { text, breaks };
  }

  function getSentences(el) {
    if (sentCache.has(el)) return sentCache.get(el);
    const { text, breaks } = blockTextWithBreaks(el);
    // Split into segments at <br> offsets, then sentence-split within each segment so no
    // sentence spans a hard line break. Offsets stay in textContent space → ranges map.
    let bounds = [0, text.length];
    for (const b of breaks) if (b > 0 && b < text.length) bounds.push(b);
    bounds = bounds.filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const base = bounds[i];
      const seg = text.slice(base, bounds[i + 1]);
      if (!seg.trim()) continue;
      for (const s of splitSentences(seg)) {
        out.push({ text: s.text, start: base + s.start, end: base + s.end });
      }
    }
    const result = out.length ? out : [{ text: text.trim(), start: 0, end: text.length }];
    sentCache.set(el, result);
    return result;
  }

  function sentenceAt(sents, offset) {
    // Offsets are trimmed, so whitespace between sentences belongs to neither —
    // fall back to the nearest sentence instead of the block's last one.
    let best = null, bestD = Infinity;
    for (const s of sents) {
      if (offset >= s.start && offset <= s.end) return s;
      const d = offset < s.start ? s.start - offset : offset - s.end;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  // ── CURSOR → CHAR OFFSET  (Speechify Xe() technique) ──────────────────────

  function charOffsetInBlock(x, y, el) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
    }
    if (!range) return 0;
    const tn = range.startContainer;
    if (tn.nodeType !== Node.TEXT_NODE || !el.contains(tn)) return 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let off = 0;
    for (let node; (node = walker.nextNode());) {
      if (node === tn) return off + range.startOffset;
      off += node.textContent.length;
    }
    return 0;
  }

  // ── CHAR POSITIONS → DOM RANGE ─────────────────────────────────────────────

  function createRangeForChars(el, startChar, endChar) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let offset = 0, sNode, sOff, eNode, eOff;
    for (let node; (node = walker.nextNode());) {
      const len = node.textContent.length;
      if (!sNode && offset + len > startChar) {
        sNode = node;
        sOff  = startChar - offset;
      }
      if (sNode && offset + len >= endChar) {
        eNode = node;
        eOff  = endChar - offset;
        break;
      }
      offset += len;
    }
    if (!sNode) return null;
    try {
      const r = document.createRange();
      r.setStart(sNode, Math.min(sOff, sNode.textContent.length));
      r.setEnd(
        eNode || sNode,
        Math.min(eOff ?? sNode.textContent.length, (eNode || sNode).textContent.length)
      );
      return r;
    } catch (_) { return null; }
  }

  // ── BLOCK FROM CURSOR POINT ────────────────────────────────────────────────

  function blockFromPoint(x, y, strict) {
    try {
      // caretRangeFromPoint is WebKit/Chrome; Firefox exposes caretPositionFromPoint.
      // Without the Firefox branch this always fell through to the weak nearest-Y
      // fallback, which mis-resolves pages with one huge block (e.g. a whole essay
      // in a single <p>).
      let node = null;
      if (document.caretRangeFromPoint) {
        const range = document.caretRangeFromPoint(x, y);
        if (range) node = range.startContainer;
      } else if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        if (pos) node = pos.offsetNode;
      }
      if (node) {
        if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
        while (node && node !== document.body) {
          const idx = blockMap.get(node);
          if (idx !== undefined) return idx;
          node = node.parentElement;
        }
      }
    } catch (_) { /* cross-origin frame, ShadowRoot, or detached node */ }
    // Click-to-seek passes strict: a click without a real text caret (scrollbar
    // gutter, empty margin) must NOT resolve to the nearest block by Y, or it
    // seeks to whatever happens to be closest.
    if (strict) return -1;
    let best = -1, bestD = Infinity;
    blocks.forEach((el, i) => {
      try {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const d = Math.abs((r.top + r.bottom) / 2 - y);
        if (d < bestD) { bestD = d; best = i; }
      } catch (_) {}
    });
    return best;
  }

  // ── LINE RECTS FROM RANGE ──────────────────────────────────────────────────

  function getLineRects(range) {
    if (!range) return [];
    try {
      const raw = [...range.getClientRects()].filter(r => r.width > 4 && r.height > 0);
      return mergeRects(raw);
    } catch (_) { return []; }
  }

  // ── CURSOR HIT-TEST ────────────────────────────────────────────────────────
  //
  // caretRangeFromPoint() snaps to the nearest character even when the cursor
  // is in empty margin space beside a line.  We reject hover unless the cursor
  // is physically over (or between adjacent lines of) the sentence's text rects.
  //
  //   PAD_X — small horizontal fuzz so the very edge of a glyph still triggers
  //   inter-line gap — if cursor Y is between rect[i].bottom and rect[i+1].top
  //     (the typographic leading gap) we still consider it "over" the sentence

  function cursorNearRects(x, y, rects) {
    if (!rects.length) return false;
    const PAD_X = 4;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      // Cursor must be horizontally inside the text run (± PAD_X)
      if (x < r.left - PAD_X || x > r.right + PAD_X) continue;
      // Vertically inside this line rect
      if (y >= r.top && y <= r.bottom) return true;
      // Vertically in the leading gap between this line and the next
      if (i + 1 < rects.length && y > r.bottom && y < rects[i + 1].top) return true;
    }
    return false;
  }

  // ── SVG HELPERS ────────────────────────────────────────────────────────────

  function makeSvgLayer(zIndex) {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:' + zIndex + ';overflow:hidden';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible';
    wrap.appendChild(svg);
    document.body.appendChild(wrap);
    return { wrap, svg };
  }

  // Merge rects on the same line that overlap horizontally — range.getClientRects()
  // returns extra rects for inline elements (links, bold) inside the range, causing
  // double-painted (darker) spots where they overlap the line rect.
  function mergeRects(rects) {
    if (rects.length < 2) return rects;
    const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
    const out = [];
    for (const r of sorted) {
      // Same line (vertical overlap > half the smaller height — inline boxes like
      // <code> sit a few px off) and touching horizontally → one rect.
      const j = out.findIndex(o =>
        Math.min(o.bottom, r.bottom) - Math.max(o.top, r.top) > 0.5 * Math.min(o.height, r.height)
        && r.left <= o.right + 1 && r.right >= o.left - 1);
      if (j >= 0) {
        const o = out[j];
        const left = Math.min(o.left, r.left), top = Math.min(o.top, r.top);
        const right = Math.max(o.right, r.right), bottom = Math.max(o.bottom, r.bottom);
        out[j] = { left, top, right, bottom, width: right - left, height: bottom - top };
      } else {
        out.push(r);
      }
    }
    return out;
  }

  // Vertical extent to paint per rect: adjacent lines meet at the middle of the
  // leading gap, so a multi-line sentence reads as one block instead of stripes
  // (and tight line-heights no longer double-paint the overlap). Only gaps
  // smaller than ~a line count — anything larger is a real visual break.
  function paintBands(rects) {
    const lines = [];
    for (const r of rects) {
      // Same line = vertical overlap of more than half the smaller height. Inline
      // boxes (<code> padding, <small>, <sup>) sit a few px off the text's top.
      const l = lines.find(l =>
        Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) > 0.5 * Math.min(l.bottom - l.top, r.bottom - r.top));
      if (l) { l.top = Math.min(l.top, r.top); l.bottom = Math.max(l.bottom, r.bottom); l.rects.push(r); }
      else lines.push({ top: r.top, bottom: r.bottom, rects: [r] });
    }
    lines.sort((a, b) => a.top - b.top);
    const band = new Map();
    for (const l of lines) for (const r of l.rects) band.set(r, { top: r.top - 1, bottom: r.bottom + 1 });
    for (let i = 0; i + 1 < lines.length; i++) {
      const a = lines[i], b = lines[i + 1];
      const gap = b.top - a.bottom;
      if (gap > 0.8 * Math.min(a.bottom - a.top, b.bottom - b.top)) continue;
      const mid = (a.bottom + b.top) / 2;
      for (const r of a.rects) band.get(r).bottom = mid;
      for (const r of b.rects) band.get(r).top = mid;
    }
    return band;
  }

  function fillSvg(svg, rects, color, alpha) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const band = paintBands(rects);
    for (const r of rects) {
      const v = band.get(r);
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      el.setAttribute('x',            (r.left   - 1).toFixed(1));
      el.setAttribute('y',            v.top.toFixed(1));
      el.setAttribute('width',        (r.width  + 2).toFixed(1));
      el.setAttribute('height',       (v.bottom - v.top).toFixed(1));
      el.setAttribute('rx',           '3');
      el.setAttribute('fill',         color);
      el.setAttribute('fill-opacity', alpha);
      svg.appendChild(el);
    }
  }

  function clearSvg(svg) {
    if (svg) while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  // ── HOVER OVERLAY ──────────────────────────────────────────────────────────

  function ensureHovSvg() {
    if (hovWrap) return;
    const layer = makeSvgLayer(2147483646);
    hovWrap = layer.wrap; hovSvg = layer.svg;
  }

  function clearHover() {
    clearSvg(hovSvg);
    if (actWrap) actWrap.style.visibility = '';
  }

  function updateHover(x, y) {
    try {
      const idx = blockFromPoint(x, y);
      if (idx < 0) { clearHover(); return; }
      const el = blocks[idx];
      if (!el) { clearHover(); return; }   // stale index — rescan pending
      const sents = getSentences(el);
      const off   = charOffsetInBlock(x, y, el);
      const sent  = sentenceAt(sents, off);
      if (!sent) { clearHover(); return; }
      const range = createRangeForChars(el, sent.start, sent.end);
      const rects = getLineRects(range);
      // Reject if cursor is in the empty margin beside the text line
      if (!cursorNearRects(x, y, rects)) { clearHover(); return; }
      ensureHovSvg();
      fillSvg(hovSvg, rects, HOVER_COLOR, HOVER_ALPHA);
      if (actWrap) actWrap.style.visibility = 'hidden';
    } catch (_) { clearHover(); }
  }

  // ── PLAYBACK HIGHLIGHT ─────────────────────────────────────────────────────
  //
  // Poll getPlaybackState every POLL_MS.
  // texts[position.index] = currently spoken sentence (Supertonic/Piper) or
  //   750-char chunk (Chrome TTS).
  // Search block.textContent with a 4-tier fallback:
  //   exact → case-insensitive → 40-char prefix exact → 40-char prefix CI
  // Store the Range so scroll can repaint instantly without waiting for a poll.

  function ensureActSvg() {
    if (actWrap) return;
    const layer = makeSvgLayer(2147483644);
    actWrap = layer.wrap; actSvg = layer.svg;
  }

  function clearPlayback() {
    clearSvg(actSvg);
    actRange   = null;
    lastPlayKey = '';
    cursorBlock = null;
    cursorChar  = 0;
    lastTextIdx = -1;
  }

  function repaintPlayback() {
    if (!actRange || !actSvg) return;
    fillSvg(actSvg, getLineRects(actRange), PLAY_COLOR, actAlpha);
  }

  // Dark page = light text. The text colour is reliable where the background
  // isn't (background images, gradients, transparent chains up to <html>).
  function playAlphaFor(node) {
    try {
      const el = node.nodeType === 1 ? node : node.parentElement;
      const m = getComputedStyle(el).color.match(/[\d.]+/g);
      if (!m) return PLAY_ALPHA;
      const lum = (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
      return lum > 0.6 ? PLAY_ALPHA_DARK : PLAY_ALPHA;
    } catch (_) { return PLAY_ALPHA; }
  }

  // html-doc.js (same content-script world) records one entry per extracted
  // paragraph in readAloudDoc._highlightEntries, and speechInfo.position
  // .originalTextIndex points at the entry the current chunk came from. That
  // element anchors the needle search, disambiguating sentences that repeat
  // elsewhere on the page. position.chunkStart (the chunk's char offset within
  // the entry text) additionally tells WHICH occurrence is meant when the
  // sentence repeats inside the same entry.
  function getPlaybackAnchor(position) {
    try {
      if (!position || position.originalTextIndex == null) return null;
      const entries = (typeof readAloudDoc !== 'undefined') && readAloudDoc._highlightEntries;
      if (!entries) return null;
      const entry = entries[position.originalTextIndex];
      if (!entry || !entry.elem || !entry.elem.isConnected) return null;
      // A body-wide anchor scopes nothing and would override the forward
      // cursor with a first-match pick — let the cursor search handle it.
      if (entry.elem === document.body || entry.elem === document.documentElement) return null;
      // On legacy shared containers many entries map to one element, so the
      // occurrence count must include ALL earlier same-element entries —
      // even ones a seek sliced away (their text is still in the DOM).
      // html-doc keeps the unsliced list + slice offset for this. The actual
      // counting happens per match tier in findTextInScope.
      const all = readAloudDoc._highlightEntriesAll || entries;
      const upto = (readAloudDoc._highlightEntriesOffset || 0) + position.originalTextIndex;
      const priorTexts = [];
      for (let i = 0; i < upto && i < all.length; i++) {
        if (all[i].elem === entry.elem && all[i].text) priorTexts.push(all[i].text);
      }
      // Click-to-seek may have cut a sentence-level prefix off this element's
      // entry text (html-doc.js parse()) to seek mid-paragraph. That prefix is
      // still in the DOM but no longer in any entry's .text, so occurrence
      // counting would miss it — add it back once, regardless of whether the
      // current entry IS the sliced one or a later entry of the same element.
      if (readAloudDoc._seekSlicePrefix && readAloudDoc._seekSliceElem === entry.elem)
        priorTexts.push(readAloudDoc._seekSlicePrefix);
      return {
        elem: entry.elem,
        priorTexts: priorTexts,
        entryText: entry.text || '',
        chunkStart: position.chunkStart,
      };
    } catch (_) { return null; }
  }

  // Char offsets of scopeEl's text within block.textContent — used when the
  // anchor element sits inside a larger scanned block, so matches outside the
  // anchor (e.g. the same sentence in a sibling paragraph) are rejected.
  function scopeBounds(block, scopeEl) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let off = 0, start = -1;
    for (let node; (node = walker.nextNode());) {
      if (scopeEl.contains(node)) {
        if (start < 0) start = off;
      } else if (start >= 0) {
        return { start, end: off };
      }
      off += node.textContent.length;
    }
    return start >= 0 ? { start, end: off } : null;
  }

  function countIn(hay, probe, before) {
    let n = 0, pos = hay.indexOf(probe);
    while (pos >= 0 && (before == null || pos < before)) {
      n++;
      pos = hay.indexOf(probe, pos + 1);
    }
    return n;
  }

  // Anchored search: collect every occurrence of the probe inside the anchor
  // scope and pick the one the chunk position points at (clamped, so a
  // divergent count still lands on the nearest occurrence instead of missing).
  // One match tier at a time — weaker tiers (case-insensitive, 40-char prefix)
  // only apply when stronger ones found nothing anywhere in the scope. The
  // occurrence is counted with the SAME probe in extraction-text space: the
  // exact chunk often can't match the DOM (appended punctuation, numbering),
  // so a prefix tier must use prefix-based counts too — identical refrain
  // sentences share their first 40 chars, and mixing tiers picked the wrong one.
  function findTextInScope(needle, anchor) {
    if (!needle || !needle.trim()) return null;
    const scopeEl = anchor.elem;
    const probes = [
      { s: needle, ci: false },
      { s: needle.toLowerCase(), ci: true },
      { s: needle.slice(0, 40), ci: false },
      { s: needle.slice(0, 40).toLowerCase(), ci: true },
    ];
    for (const probe of probes) {
      let occurrence = 0;
      for (const t of anchor.priorTexts)
        occurrence += countIn(probe.ci ? t.toLowerCase() : t, probe.s, null);
      if (anchor.chunkStart != null)
        occurrence += countIn(probe.ci ? anchor.entryText.toLowerCase() : anchor.entryText, probe.s, anchor.chunkStart);
      const matches = [];
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi];
        let from = 0, limit = Infinity;
        if (!scopeEl.contains(block)) {
          if (!block.contains(scopeEl)) continue;
          const b = scopeBounds(block, scopeEl);
          if (!b) continue;
          from  = b.start;
          limit = b.end;
        }
        const tc = probe.ci ? block.textContent.toLowerCase() : block.textContent;
        let pos = tc.indexOf(probe.s, from);
        while (pos >= 0 && pos < limit) {
          matches.push({ block: block, pos: pos });
          pos = tc.indexOf(probe.s, pos + 1);
        }
      }
      // Keep only matches that actually render: pages carry invisible copies of
      // their text (collapsed embeds, email/preview duplicates, zero-size nodes).
      // Highlighting one of those paints nothing and scrolls the reader off to it.
      const visible = [];
      for (const m of matches) {
        const tc = m.block.textContent;
        const end = Math.min(tc.length, m.pos + needle.length);
        const range = createRangeForChars(m.block, m.pos, end);
        if (range && getLineRects(range).length)
          visible.push({ range: range, block: m.block, endChar: end });
      }
      if (visible.length) return visible[Math.min(occurrence, visible.length - 1)];
    }
    return null;
  }

  // Search blocks for `needle`, resuming at (fromBlockEl, fromChar) so sequential
  // playback keeps moving forward past earlier identical sentences. When fromBlockEl
  // is null (or stale after a rescan) the whole document is searched from the top.
  function findTextInBlocks(needle, fromBlockEl, fromChar) {
    if (!needle || !needle.trim()) return null;
    const prefix = needle.slice(0, 40);
    let startIdx = 0;
    if (fromBlockEl) {
      const bi = blockMap.get(fromBlockEl);
      if (bi !== undefined) startIdx = bi;
      else fromBlockEl = null;   // block dropped out on rescan — fall back to top
    }
    for (let bi = startIdx; bi < blocks.length; bi++) {
      const block = blocks[bi];
      const tc = block.textContent;
      const from = (fromBlockEl && bi === startIdx) ? fromChar : 0;
      const tcLower = tc.toLowerCase();
      let pos = tc.indexOf(needle, from);
      if (pos < 0) pos = tcLower.indexOf(needle.toLowerCase(), from);
      if (pos < 0) pos = tc.indexOf(prefix, from);
      if (pos < 0) pos = tcLower.indexOf(prefix.toLowerCase(), from);
      if (pos < 0) continue;
      const end   = Math.min(tc.length, pos + needle.length);
      const range = createRangeForChars(block, pos, end);
      // Skip matches that render nothing (invisible duplicate copies of the text)
      // and keep looking in later blocks for the one the reader can see.
      if (range && getLineRects(range).length) return { range, block, endChar: end };
    }
    return null;
  }

  function isRectNearEdgeOrOffscreen(rect, view) {
    return rect.bottom < view.top || rect.top > view.top + view.height * 0.75;
  }

  function applyPlaybackHighlight(needle, fromBlockEl, fromChar, anchor) {
    // Anchored search first (exact element + occurrence the chunk came from),
    // then page-wide from the cursor, then page-wide from the top (handles
    // restart-from-beginning and the rare case where the cursor overran).
    // Each step only runs when the previous one missed, so anchoring can't
    // regress pages where the anchor is stale or mismatched.
    let found = anchor ? findTextInScope(needle, anchor) : null;
    const anchored = !!found;
    if (!found) found = findTextInBlocks(needle, fromBlockEl, fromChar);
    if (!found && fromBlockEl) found = findTextInBlocks(needle, null, 0);
    if (!found) return null;   // keep previous rects — text may be mid-transition

    const rects = getLineRects(found.range);
    if (!rects.length) return null;   // nothing to paint — keep the previous highlight
    actRange = found.range;
    actAlpha = playAlphaFor(found.range.startContainer);
    ensureActSvg();
    fillSvg(actSvg, rects, PLAY_COLOR, actAlpha);

    // Only follow the highlight when we trust the location: an anchored match, or
    // an unanchored page-wide one. A page-wide match found DESPITE having an anchor
    // is a guess — short chunks like a heading also occur mid-sentence elsewhere
    // ("…of the incident.") — so paint it but never yank the view across the page.
    const trusted = anchored || !anchor
      || anchor.elem.contains(found.block) || found.block.contains(anchor.elem);
    const view = window.raScrollView(found.block);
    if (trusted && isRectNearEdgeOrOffscreen(rects[0], view)) {
      // Scroll to the sentence, not to its block: a block can be a synthetic run
      // spanning most of the page (wrappers with display:contents collapse into
      // one), and its top is then nowhere near the sentence being read.
      window.raScrollTo(view, rects[0].top, 0.3);
    }
    return found;
  }

  async function pollPlayback() {
    if (pollActive) return;
    pollActive = true;
    try {
      let result;
      try {
        result = await safeSend({ dest: 'serviceWorker', method: 'getPlaybackState' });
      } catch (_) { return; }

      if (!result || result.state !== 'PLAYING') {
        // PAUSED keeps the reader "active" so hover/click still work; only
        // the playback highlight fades after the debounce.
        if (result && result.state === 'PAUSED') readerActive = true;
        // Debounce clears: brief STOPPED blips between sentences shouldn't blank
        // the highlight or deactivate hover. A real stop persists past 800 ms,
        // so we re-check state when the timer fires.
        if (result && (result.state === 'PAUSED' || result.state === 'STOPPED')) {
          if (!clearDebounceTimer)
            clearDebounceTimer = setTimeout(function () {
              clearDebounceTimer = null;
              clearPlayback();
              safeSend({ dest: 'serviceWorker', method: 'getPlaybackState' }).then(function (r) {
                if (!r || r.state === 'STOPPED') {
                  readerActive = false;
                  clearHover();
                }
              }).catch(function () {});
            }, 800);
        }
        return;
      }

      if (clearDebounceTimer) { clearTimeout(clearDebounceTimer); clearDebounceTimer = null; }
      readerActive = true;

      const info = result.speechInfo;
      if (!info || !info.texts || !info.texts.length) return;

      const idx  = (info.position && info.position.index != null) ? info.position.index : 0;
      const text = info.texts[idx];
      if (!text) return;

      const key = idx + ':' + text;
      if (key === lastPlayKey) return;

      // A chunk that is only a list marker (e.g. "2.", "(a)" from addNumbering)
      // has no meaningful location — its bare digits would indexOf-match a
      // random decimal elsewhere and yank the highlight there. Keep the current
      // highlight put and just advance the play key so we don't re-poll it.
      if (/^\s*\(?\d{1,3}[).]\s*$/.test(text) || /^\s*\(?[a-zA-Z][).]\s*$/.test(text)) {
        lastTextIdx = idx;
        lastPlayKey = key;
        return;
      }

      // Resume the search at the cursor while playback advances; a non-increasing
      // idx means a seek-back or restart, so search the document from the top.
      const goneBackward = idx <= lastTextIdx;
      const fromEl   = goneBackward ? null : cursorBlock;
      const fromChar = goneBackward ? 0    : cursorChar;
      // speech.js appends a "." to any text ending in a word character, which the
      // DOM does not have — a short chunk (a heading) then misses every match tier
      // in its own anchor scope and the page-wide fallback lands somewhere random.
      const needle = text.replace(/\.\s*$/, '') || text;
      const found = applyPlaybackHighlight(needle, fromEl, fromChar, getPlaybackAnchor(info.position));
      if (found) {
        cursorBlock = found.block;
        cursorChar  = found.endChar;
        lastTextIdx = idx;
        lastPlayKey = key;
      }
    } finally {
      pollActive = false;
    }
  }

  // ── SAFE MESSAGING ────────────────────────────────────────────────────────
  //
  // chrome.runtime.sendMessage() throws synchronously with
  // "Extension context invalidated" when the service worker has restarted
  // (idle timeout, extension reload) while this content script is still live.
  // That happens before a Promise is returned, so .catch() on the call-site
  // can't catch it.  Wrap every outgoing message here instead.

  function safeSend(msg) {
    try {
      const p = brapi.runtime.sendMessage(msg);
      // brapi may return undefined for one-way messages
      return (p && typeof p.then === 'function') ? p : Promise.resolve(null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  // ── CLICK-TO-SEEK ──────────────────────────────────────────────────────────

  async function handlePointerUp(e) {
    try {
      if (e.button !== 0) return;
      if (window.getSelection().toString().length > 0) return;
      if (e.target.closest && e.target.closest(INTERACTIVE)) return;

      // Only seek when TTS is already active — don't trigger playback from a cold stop
      const state = await safeSend({ dest: 'serviceWorker', method: 'getPlaybackState' });
      if (!state || (state.state !== 'PLAYING' && state.state !== 'PAUSED')) return;

      const idx = blockFromPoint(e.clientX, e.clientY, true);
      if (idx < 0) return;
      const el = blocks[idx];
      if (!el) return;
      const sents = getSentences(el);
      const off   = charOffsetInBlock(e.clientX, e.clientY, el);
      const sent  = sentenceAt(sents, off);
      if (!sent) return;

      // Signal html-doc.js's parse() to start from this sentence
      window.__raSeekTarget = {
        el:           el,
        sentenceText: sent.text.replace(/\s+/g, ' ').trim()
      };

      // Clear both overlays — they will repopulate once new playback starts
      clearHover();
      clearPlayback();

      // Seed the search cursor at the clicked sentence so the first post-seek
      // highlight lands here even if this sentence repeats earlier in the page.
      cursorBlock = el;
      cursorChar  = sent.start;

      safeSend({ dest: 'serviceWorker', method: 'stop' })
        .catch(function () {})
        .then(function () {
          return safeSend({ dest: 'serviceWorker', method: 'playTab' });
        })
        .catch(function (err) { console.error('[RA hover] playTab failed:', err); });
    } catch (err) {
      console.error('[RA hover] click handler error:', err);
    }
  }

  // ── BLOCK SCANNING ─────────────────────────────────────────────────────────

  function isVisible(el) {
    if (!el.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  const BLOCK_TAGS = new Set([
    'p','li','blockquote','td','th','pre','figcaption',
    'h1','h2','h3','h4','h5','h6',
    // Legacy HTML uses <ul>/<ol>/<dl> for indentation with bare text + <br>;
    // treating them as blocks lets click-to-seek work on those passages.
    'ul','ol','dl','dd','dt'
  ]);

  const IGNORE_SEL = (typeof readAloudDoc !== 'undefined' && readAloudDoc.ignoreTags)
    ? readAloudDoc.ignoreTags
    : 'select,textarea,button,label,audio,video,dialog,embed,nav,noframes,noscript,object,script,style,svg,aside,footer';

  function isBlockEl(node) {
    return node.nodeType === 1 && BLOCK_TAGS.has(node.tagName.toLowerCase());
  }

  // A node belongs to a bare-text run only if it's text or an inline-level element
  // (<a>, <font>, <b>, <span>, <br>…). Structural non-block containers (<div>,
  // <section>) must be recursed into, not swallowed into one synthetic block.
  function isInlineNode(node) {
    if (node.nodeType === 3) return true;
    if (node.nodeType !== 1) return false;
    if (node.tagName === 'BR') return true;
    let d = '';
    try { d = getComputedStyle(node).display; } catch (_) {}
    return d.indexOf('inline') === 0 || d === 'ruby' || d === 'contents';
  }

  function hasBlockDescendant(el) {
    for (const child of el.children) {
      if (BLOCK_TAGS.has(child.tagName.toLowerCase())) return true;
      if (hasBlockDescendant(child)) return true;
    }
    return false;
  }

  // Remove the synthetic <span data-ra-block> wrappers from a previous scan so
  // re-scanning rebuilds them deterministically (no nesting).
  function unwrapSyntheticBlocks() {
    const spans = document.querySelectorAll('span[data-ra-block]');
    for (const s of spans) {
      const p = s.parentNode;
      if (!p) continue;
      while (s.firstChild) p.insertBefore(s.firstChild, s);
      p.removeChild(s);
    }
  }

  function scanBlocks() {
    // Pause our own observer while we mutate the DOM (unwrap + re-wrap), then drop
    // the resulting records so we don't trigger an endless rescan loop.
    if (domObserver) domObserver.disconnect();
    try {
      unwrapSyntheticBlocks();

      const candidates = [];

      // Group consecutive non-block child nodes (bare text + inline elements,
      // including <br>) into one synthetic block. Legacy pages drop whole
      // paragraphs as loose text under <body>/<td> with <br> separators and
      // <ul> used for indentation — those have no block element to highlight.
      function flushRun(parent, run) {
        if (!run.length) return;
        let txt = '';
        for (const n of run) txt += (n.textContent || '');
        if (txt.trim().length < MIN_TEXT) return;
        const span = document.createElement('span');
        span.setAttribute('data-ra-block', '');
        parent.insertBefore(span, run[0]);
        for (const n of run) span.appendChild(n);
        if (isVisible(span)) candidates.push(span);
      }

      function descend(el) {
        let run = [];
        // Snapshot childNodes — flushRun mutates the live list as it wraps.
        const kids = Array.prototype.slice.call(el.childNodes);
        for (const node of kids) {
          if (node.nodeType === 1) {
            let ignore = false;
            try { ignore = node.matches(IGNORE_SEL); } catch (_) {}
            if (ignore) { flushRun(el, run); run = []; continue; }
            // Block-tag OR structural (display:block) element → boundary; recurse.
            if (isBlockEl(node) || !isInlineNode(node)) {
              flushRun(el, run); run = []; walk(node); continue;
            }
          } else if (node.nodeType !== 3) {
            continue;   // comment / other — ignore
          }
          run.push(node);   // text node or inline element → accumulate
        }
        flushRun(el, run);
      }

      function walk(el) {
        if (!el || el.nodeType !== 1) return;
        try { if (el.matches(IGNORE_SEL)) return; } catch (_) {}
        if (isBlockEl(el)) {
          // A block that itself holds block-level children (e.g. legacy
          // table-as-layout <td> wrapping the page) — descend and also pick up
          // any loose text mixed between those child blocks.
          if (hasBlockDescendant(el)) { descend(el); return; }
          if ((el.textContent || '').trim().length >= MIN_TEXT && isVisible(el))
            candidates.push(el);
          return;
        }
        descend(el);
      }
      walk(document.body);

      const set = new Set(candidates);
      blocks = candidates.filter(function (el) {
        let p = el.parentElement;
        while (p && p !== document.body) { if (set.has(p)) return false; p = p.parentElement; }
        return true;
      });
      blockMap = new Map(blocks.map(function (el, i) { return [el, i]; }));
    } finally {
      if (domObserver) {
        domObserver.takeRecords();
        domObserver.observe(document.body, { childList: true, subtree: true });
      }
    }
  }

  // ── INIT (only when in-page highlighting is active) ────────────────────────

  brapi.storage.local.get("showHighlighting", function(s) {
    if (Number(s.showHighlighting) !== 3) return;

    window.__raHoverOverlayActive = true;

    scanBlocks();

    document.addEventListener('mousemove', function (e) {
      if (hovTimer) return;
      hovTimer = setTimeout(function () { hovTimer = 0; }, HOVER_MS);
      // Reader inactive (never started or stopped) → no hover preview / no click affordance
      if (!readerActive) { clearHover(); return; }
      if (e.target.closest && e.target.closest(INTERACTIVE)) { clearHover(); return; }
      ensureHovSvg();
      updateHover(e.clientX, e.clientY);
    }, { capture: true, passive: true });

    document.addEventListener('mouseleave', clearHover, { capture: true });

    document.addEventListener('scroll', function () {
      clearHover();
      repaintPlayback();
    }, { capture: true, passive: true });

    document.addEventListener('pointerup', handlePointerUp, { capture: true });

    let rescanTimer = null;
    domObserver = new MutationObserver(function (mutations) {
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type !== 'childList') continue;
        if (m.addedNodes.length === 0 && m.removedNodes.length === 0) continue;
        if (hovWrap && hovWrap.contains(m.target)) continue;
        if (actWrap && actWrap.contains(m.target)) continue;
        // Ignore mutations that ARE us — adding/removing our own overlay wraps
        let mine = false;
        for (let j = 0; j < m.addedNodes.length; j++) {
          const n = m.addedNodes[j];
          if (n === hovWrap || n === actWrap) { mine = true; break; }
        }
        if (!mine) {
          for (let j = 0; j < m.removedNodes.length; j++) {
            const n = m.removedNodes[j];
            if (n === hovWrap || n === actWrap) { mine = true; break; }
          }
        }
        if (mine) continue;
        if (rescanTimer) clearTimeout(rescanTimer);
        rescanTimer = setTimeout(function () {
          rescanTimer = null;
          sentCache = new WeakMap();
          scanBlocks();
          // Don't clear playback/hover — the active range stays valid as long
          // as its DOM nodes remain. Page mutations (lazy images, ads) shouldn't
          // wipe the user's highlight.
        }, 500);
        return;
      }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });

    pollTimer = setInterval(pollPlayback, POLL_MS);
  });

})();
