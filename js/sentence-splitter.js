// Shared sentence splitter — single source of truth for sentence boundaries,
// used by both the TTS chunker (LatinPunctuator in js/speech.js, player page)
// and the in-page overlay (js/content/hover-overlay.js), so hover/click-to-seek
// boundaries match the actual spoken chunks.
//
// Boundary rule: terminal punctuation, optional closing quotes/brackets, then
// whitespace — unless the preceding word is a known abbreviation (or a single
// letter, e.g. initials) or the next sentence would start with a lowercase
// letter (mid-sentence abbreviation not in the list).

var raSentenceSplitter = (function() {
  'use strict';

  // Abbreviations whose trailing period must not end a sentence. Entries are
  // matched case-sensitively, plus a decapitalized retry so "Vgl." matches
  // "vgl" — but "no"/"min"/"est" as ordinary words still end sentences.
  const ABBREVS = new Set([
    // English titles, street/org suffixes, citations
    'Adm','Assn','Ave','Blvd','Bldg','Brig','Capt','Cmdr','Col','Comdr','Corp',
    'Cpl','Ct','Dept','Dr','Drs','Fig','Figs','Fr','Ft','Gen','Gov','Hon','Inc',
    'Jr','Lieut','Ln','Lt','Ltd','Maj','Messrs','Mmes','Mr','Mrs','Ms','Mt','Mx',
    'No','Nos','Pl','Pres','Prof','Rd','Rep','Reps','Rev','Sen','Sens','Sgt',
    'Sr','St','Ste','Univ','Co',
    'dept','ed','eds','est','fig','figs','misc','pp','ref','refs','vol','vols',
    'vs','e.g','i.e','approx','govt','U.S','U.K','U.N','p.m','a.m',
    // months
    'Jan','Feb','Mar','Apr','Jun','Jul','Aug','Sep','Sept','Oct','Nov','Dec',
    // German
    'Abb','Abk','Abs','allg','Anh','Anm','Aufl','Bd','Bde','bzgl','bzw','ca',
    'd.h','dt','ebd','etc','evtl','ggf','Hrsg','inkl','inn','insb','i.d.R',
    'Jh','Jh.s','Jhd','Kap','max','min','Mio','Mrd','n.Chr','Nr','österr',
    'Pkt','röm','Rn','Rr','s.o','s.u','sog','Std','Str','u.a','u.ä',
    'u.U','usw','v.a','v.Chr','vgl','z.B','z.T',
  ]);

  // punctuation run, optional closing quotes/brackets, whitespace (incl. ZWSP)
  const BOUNDARY_RE = /([.!?]+)(['"»«)\]’“”]*)([\s\u200b]+)/g;

  function isAbbrev(word) {
    return ABBREVS.has(word)
      || ABBREVS.has(word.charAt(0).toLowerCase() + word.slice(1));
  }

  // Offsets where a new sentence starts (just past the boundary whitespace).
  function boundaries(text) {
    const out = [];
    BOUNDARY_RE.lastIndex = 0;
    let m;
    while ((m = BOUNDARY_RE.exec(text)) !== null) {
      const next = m.index + m[0].length;
      if (next >= text.length) break;
      // Lowercase continuation → mid-sentence (unknown abbreviation, "etc. and")
      if (/\p{Ll}/u.test(text.charAt(next))) continue;
      // Single period right after a known abbreviation or a lone letter (initials)
      if (m[1] === '.' && !m[2]) {
        const head = text.slice(0, m.index);
        const wm = head.match(/(^|[\s("'«„\[])([\p{L}][\p{L}.]{0,9})$/u);
        if (wm && (wm[2].length === 1 || isAbbrev(wm[2]))) continue;
      }
      out.push(next);
    }
    return out;
  }

  // Offset-preserving parts (concat === text) — punctuation and trailing
  // whitespace stay attached to the preceding sentence, matching what the
  // TTS chunk breakers expect.
  function split(text) {
    const parts = [];
    let last = 0;
    for (const cut of boundaries(text)) {
      parts.push(text.slice(last, cut));
      last = cut;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }

  // Trimmed sentences with [start, end) offsets into the original text —
  // what the overlay needs to build DOM ranges.
  function splitWithOffsets(text) {
    const out = [];
    const push = function(start, end) {
      while (start < end && /[\s\u200b]/.test(text.charAt(start))) start++;
      while (end > start && /[\s\u200b]/.test(text.charAt(end - 1))) end--;
      if (end - start > 1) out.push({text: text.slice(start, end), start: start, end: end});
    };
    let last = 0;
    for (const cut of boundaries(text)) {
      push(last, cut);
      last = cut;
    }
    push(last, text.length);
    return out.length ? out : [{text: text.trim(), start: 0, end: text.length}];
  }

  return {split: split, splitWithOffsets: splitWithOffsets};
})();
