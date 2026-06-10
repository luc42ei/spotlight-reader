// Read Aloud — Speechify-style hover + click overlay + playback highlight
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
//      anchored findTextInBlocks (scoped to the _highlightEntries element the
//      chunk came from, falling back to a page-wide search) →
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

  const INTERACTIVE  = 'a,button,input,select,textarea,[contenteditable],[role="button"],[role="link"]';

  // Abbreviations whose period must NOT end a sentence
  const ABBREVS = new Set([
    'mr','mrs','ms','dr','drs','prof','sr','jr','vs','etc',
    'e.g','i.e','fig','figs','no','nos','vol','vols','dept','approx','est',
    'govt','inc','ltd','corp','co','st','ste','ave','blvd','rd','ln','ct','pl','mt',
    'capt','col','gen','gov','hon','lt','maj','sgt','rev','sen','rep','adm','cmdr',
    'jan','feb','mar','apr','jun','jul','aug','sep','sept','oct','nov','dec',
    'u.s','u.k','u.n','p.m','a.m',
    'abb','abk','abs','allg','anh','anm','aufl','bd','bde','bzgl','bzw','ca',
    'dt','ebd','evtl','ggf','hrsg','inkl','insb','jh','jhd','kap','max','min',
    'mio','mrd','nr','pkt','rn','sog','std','str','usw','vgl',
  ]);

  // ── STATE ──────────────────────────────────────────────────────────────────

  let blocks    = [];
  let blockMap  = new Map();      // el → index  (O(1) hit-test)
  let sentCache = new WeakMap();  // el → [{text, start, end}]

  // Hover SVG (purple, above playback layer)
  let hovWrap = null, hovSvg = null, hovTimer = 0;

  // Playback SVG (amber, below hover layer)
  let actWrap = null, actSvg = null;
  let actRange  = null;   // stored so scroll can repaint without waiting for poll
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

  function splitSentences(text) {
    if (!text) return [];
    const results = [];
    const re = /([.!?]['"»)\]]*)\s+(?=[A-Z"'«(\[])/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      const prefix = text.slice(0, m.index + 1);
      const abbr   = prefix.match(/\b([A-Za-z][a-z]*)\.$/);
      if (abbr && ABBREVS.has(abbr[1].toLowerCase())) continue;
      const end   = m.index + m[1].length;
      const chunk = text.slice(last, end).trim();
      if (chunk.length > 1) results.push({ text: chunk, start: last, end });
      last = m.index + m[0].length;
    }
    const tail = text.slice(last).trim();
    if (tail.length > 1) results.push({ text: tail, start: last, end: text.length });
    return results.length ? results : [{ text: text.trim(), start: 0, end: text.length }];
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
    for (const s of sents) {
      if (offset >= s.start && offset <= s.end) return s;
    }
    return sents[sents.length - 1] || null;
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

  function blockFromPoint(x, y) {
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
      const last = out[out.length - 1];
      if (last && Math.abs(r.top - last.top) < 2 && r.left <= last.right + 1) {
        out[out.length - 1] = {
          left: Math.min(last.left, r.left), top: Math.min(last.top, r.top),
          right: Math.max(last.right, r.right), bottom: Math.max(last.bottom, r.bottom),
          width: Math.max(last.right, r.right) - Math.min(last.left, r.left),
          height: Math.max(last.bottom, r.bottom) - Math.min(last.top, r.top),
        };
      } else {
        out.push(r);
      }
    }
    return out;
  }

  function fillSvg(svg, rects, color, alpha) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    for (const r of rects) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      el.setAttribute('x',            (r.left   - 1).toFixed(1));
      el.setAttribute('y',            (r.top    - 1).toFixed(1));
      el.setAttribute('width',        (r.width  + 2).toFixed(1));
      el.setAttribute('height',       (r.height + 2).toFixed(1));
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
    fillSvg(actSvg, getLineRects(actRange), PLAY_COLOR, PLAY_ALPHA);
  }

  // html-doc.js (same content-script world) records one entry per extracted
  // paragraph in readAloudDoc._highlightEntries, and speechInfo.position
  // .originalTextIndex points at the entry the current chunk came from. That
  // element anchors the needle search, disambiguating sentences that repeat
  // elsewhere on the page.
  function getAnchorElem(position) {
    try {
      if (!position || position.originalTextIndex == null) return null;
      const entries = (typeof readAloudDoc !== 'undefined') && readAloudDoc._highlightEntries;
      if (!entries) return null;
      const entry = entries[position.originalTextIndex];
      return (entry && entry.elem && entry.elem.isConnected) ? entry.elem : null;
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

  // Search blocks for `needle`, resuming at (fromBlockEl, fromChar) so sequential
  // playback keeps moving forward past earlier identical sentences. When fromBlockEl
  // is null (or stale after a rescan) the whole document is searched from the top.
  // With scopeEl, only blocks intersecting it are searched (clamped to its text
  // when the block is larger).
  function findTextInBlocks(needle, fromBlockEl, fromChar, scopeEl) {
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
      let from = (fromBlockEl && bi === startIdx) ? fromChar : 0;
      let limit = Infinity;
      if (scopeEl && !scopeEl.contains(block)) {
        if (!block.contains(scopeEl)) continue;
        const b = scopeBounds(block, scopeEl);
        if (!b) continue;
        from  = Math.max(from, b.start);
        limit = b.end;
      }
      const tc = block.textContent;
      const tcLower = tc.toLowerCase();
      let pos = tc.indexOf(needle, from);
      if (pos < 0) pos = tcLower.indexOf(needle.toLowerCase(), from);
      if (pos < 0) pos = tc.indexOf(prefix, from);
      if (pos < 0) pos = tcLower.indexOf(prefix.toLowerCase(), from);
      if (pos < 0 || pos >= limit) continue;
      const end   = Math.min(tc.length, pos + needle.length);
      const range = createRangeForChars(block, pos, end);
      if (range) return { range, block, endChar: end };
    }
    return null;
  }

  function isRectNearEdgeOrOffscreen(rect) {
    return rect.bottom < 0 || rect.top > window.innerHeight * 0.75;
  }

  function applyPlaybackHighlight(needle, fromBlockEl, fromChar, anchorEl) {
    // Anchored search first (the element the chunk was extracted from), then
    // page-wide from the cursor, then page-wide from the top (handles
    // restart-from-beginning and the rare case where the cursor overran).
    // Each step only runs when the previous one missed, so anchoring can't
    // regress pages where the anchor is stale or mismatched.
    let found = anchorEl ? findTextInBlocks(needle, fromBlockEl, fromChar, anchorEl) : null;
    if (!found && anchorEl) found = findTextInBlocks(needle, null, 0, anchorEl);
    if (!found) found = findTextInBlocks(needle, fromBlockEl, fromChar);
    if (!found && fromBlockEl) found = findTextInBlocks(needle, null, 0);
    if (!found) return null;   // keep previous rects — text may be mid-transition

    actRange = found.range;
    const rects = getLineRects(actRange);
    ensureActSvg();
    fillSvg(actSvg, rects, PLAY_COLOR, PLAY_ALPHA);

    if (rects.length > 0 && isRectNearEdgeOrOffscreen(rects[0])) {
      found.block.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

      // Resume the search at the cursor while playback advances; a non-increasing
      // idx means a seek-back or restart, so search the document from the top.
      const goneBackward = idx <= lastTextIdx;
      const fromEl   = goneBackward ? null : cursorBlock;
      const fromChar = goneBackward ? 0    : cursorChar;
      const found = applyPlaybackHighlight(text, fromEl, fromChar, getAnchorElem(info.position));
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

      const idx = blockFromPoint(e.clientX, e.clientY);
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
