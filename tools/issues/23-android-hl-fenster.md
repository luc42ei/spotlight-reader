# Issue #23 – Android: Hervorhebungs-Modus „In separatem Fenster anzeigen“ auf dem Handy ausblenden

**Issue:** luc42ei/spotlight-reader#23 · **Upstream:** – · **Erstellt:** 2026-11-19
**Status:** umgesetzt · **Branch:** `chore/23-android-hl-fenster`
**Umsetzung mit:** Sonnet – 2 Stellen eindeutig festgelegt, Gerätetest per Protokoll mit klarem Gate (K0)

# Teil A: Spec (Was/Warum)

## 1. Problem

Issue: „Auf Android öffnet ‚In separatem Fenster anzeigen‘ statt eines Fensters einen Tab `popup.html?tab=…`. Der Text sieht dort genauso aus wie bei ‚Im Popup anzeigen‘, ist aber umständlicher zu bedienen (Play erst im neuen Tab, Tabwechsel nötig).“

Wunsch: Option auf dem Handy nicht anbieten, Desktop unverändert; bestehende Einstellung „separates Fenster“ auf Android wie „Im Popup anzeigen“ behandeln. (Pixel 7a, Firefox 160, v3.5.0, beim Test zu #22.)

## 2. Ursache / Ausgangslage

Wert 2 wirkt an genau **einer** Stelle: Das Browser-Action-Popup (`manifest.json:24`: `popup.html?isPopup=1`) lagert sich aus.

QUELLE: `js/popup.js:33-61`
```js
getSettings(["showHighlighting", "readAloudTab"]).then(async settings => {
  if (settings.showHighlighting == 2 && queryString.isPopup) {
    await popout(settings.readAloudTab)
  } else {
    await init()
  }
}).catch(handleError)

async function popout(tabId) {
  const activeTab = await getActiveTab()
  const url = brapi.runtime.getURL("popup.html?tab=" + activeTab.id)
  try {
    if (!tabId) throw "Create"
    const tab = await updateTab(tabId, {url, active: true})
    ...
  catch (err) {
    await createWindow({ url, focused: true, type: "normal", ... })
    window.close()
```

`createWindow` ohne Windows-API → Tab:

QUELLE: `js/defaults.js:541-543`
```js
function createWindow(details) {
  //Firefox for Android has no windows API, open a tab instead
  if (!brapi.windows) return createTab(details.url)
```

Sonst behandelt das Popup 1 und 2 schon gleich (`js/popup.js:152`, `:168`: `popupHighlight = showHighlighting && showHighlighting != 3`). Player (`js/player.js:285`), Content (`js/content.js:92`), Overlay (`js/content/hover-overlay.js:908`) reagieren nur auf 3. Background/Kontextmenü/Tastenkürzel lesen `showHighlighting` nicht.

Optionen: Button-Gruppe `options.html:79-84` (Werte 1, 2, 3, 0); Schreiben `js/options.js:243`, aktive Markierung `js/options.js:247-250`:
```js
  rxjs.combineLatest([observeSetting("showHighlighting"), domReadyPromise])
    .subscribe(([showHighlighting]) => {
      const val = String(showHighlighting != null ? showHighlighting : defaults.showHighlighting)
      $("#show-highlighting button").removeClass("active").filter(`[data-value="${val}"]`).addClass("active")
    })
```

`brapi` ist in Firefox `chrome` (`js/defaults.js:1`); auf Fenix fehlt `windows` laut MDN und Code-Kommentar – durch Lucas' Beobachtung (Tab statt Fenster) gestützt, in Schritt 0 direkt gemessen.

## 3. Lösung

- **Ansatz:** Kriterium „Browser kann keine Fenster öffnen“ = `!brapi.windows` (dieselbe Prüfung wie `createWindow`/`updateWindow`). Wert 2 wird dort **beim Lesen** wie 1 behandelt, gespeicherter Wert bleibt unangetastet.
  1. `js/popup.js:34`: Bedingung um `&& brapi.windows` ergänzen → auf Android läuft `init()`, Text erscheint im Popup-Sheet wie bei 1.
  2. `js/options.js:239-251`: ohne `brapi.windows` Button `[data-value="2"]` ausblenden (`.hide()` nach `domReadyPromise`) und bei der aktiven Markierung `"2"` → `"1"` abbilden.
- **Begründung:** Kleinster Eingriff an den einzigen zwei Stellen, an denen 2 sich von 1 unterscheidet. Feature-Erkennung trifft exakt die Ursache (keine Fenster → Tab) und deckt auch Android-Tablets ab, deren UA kein „Mobile“ enthält (`isMobileOS()` würde sie verfehlen). Desktop: `brapi.windows` vorhanden → Code-Pfad identisch. Keine Permission, kein Locale-Text, kein Storage-Schreiben.
- **Pflaster-Check:** (1) Beide Wünsche erfüllt (ausblenden + bestehenden Wert abbilden). (2) Kein späterer Umbau. (3) Bestehendes Muster `!brapi.windows` aus `defaults.js:543/553`; die Lese-Normalisierung entspricht dem vorhandenen Stil (`popup.js:152`, `options.js:249` deuten den Wert auch lokal).
- **Verworfen:**
  - `isMobileOS()` – UA-Regex, verfehlt Android-Tablets (dort öffnet sich ebenfalls ein Tab); zweites Kriterium neben dem bestehenden `brapi.windows`.
  - Gespeicherten Wert auf Android einmalig auf 1 umschreiben (Migration) – braucht Auslösezeitpunkt (Popup? Optionen? Background-Start?) und Schreibzugriff; Leseabbildung reicht, `storage.local` ist ohnehin gerätelokal.
  - Zentraler Helfer in `defaults.js` (z. B. `effectiveShowHighlighting`) – nur zwei Stellen, eine davon ein reines Anzeige-Mapping; Helfer wäre mehr Code als Nutzen.

## 4. Messung (Baseline = Abnahme)

Gerät: Pixel 7a, Firefox 160, `web-ext run -t firefox-android` (Setup aus #20/#22). Desktop: Firefox Linux, `web-ext run`. Testseite: `https://de.wikipedia.org/wiki/Geschichte_Berlins`. Kein Harness möglich (Popup + Fenix) → Protokoll.

**P0 (Fakt):** Fenix, Optionsseite **und** Tab `popup.html` der Erweiterung, Konsole via `about:debugging` (Desktop, USB) oder RDP-Client (Memory „Android RDP-Auslese“): `typeof chrome.windows`. Desktop gleiche Abfrage.

**P1 Android:** Einstellung in Optionen auf „In separatem Fenster“ (Baseline) bzw. vorab per Konsole `chrome.storage.local.set({showHighlighting: 2})` (Abnahme, Button fehlt dann). Artikel öffnen, Firefox-Menü → Spotlight Reader. Notieren: öffnet sich ein neuer Tab `popup.html?tab=…`? Erscheint das Popup-Sheet mit Play-Knopf? Play → Text erscheint im Sheet, Wiedergabe läuft? 3 Läufe.

**P2 Android Optionen:** Optionsseite öffnen, zählen: sichtbare Hervorhebungs-Buttons; welcher ist bei gespeichertem Wert 2 aktiv markiert. Klick „Im Popup anzeigen“ → `chrome.storage.local.get("showHighlighting")` = 1.

**P3 Desktop (Regression):** Wert 2 → Toolbar-Icon → separates Fenster öffnet sich, Play liest vor, Popup schließt. Optionen: 4 Buttons, Wert 2 aktiv. Wert 1/3 je 1 Lauf wie gewohnt.

| KPI | Methode | Baseline | Ziel |
| --- | --- | --- | --- |
| K0 `typeof chrome.windows` Fenix / Desktop | P0 | – | `undefined` / `object` (Gate: sonst Plan stoppen) |
| K1 Android, Wert 2: neuer/umgeleiteter Tab `popup.html?tab=` | P1, 3 Läufe | – | 0 / 3 |
| K2 Android, Wert 2: Popup-Sheet mit Text + Wiedergabe | P1, 3 Läufe | – | 3 / 3 |
| K3 Android Optionen: sichtbare Buttons · aktiv bei Wert 2 | P2 | – | 3 · „Im Popup“ |
| K4 Desktop, Wert 2: Fenster öffnet, Wiedergabe läuft | P3, 3 Läufe | – | = Baseline |
| K5 Desktop Optionen: Buttons · aktiv bei Wert 2 | P3 | – | 4 · „Separates Fenster“ |

## Entschieden vom Agenten

| Entscheidung | Verworfen | Warum | Prinzip |
| --- | --- | --- | --- |
| Kriterium `!brapi.windows` statt „Handy“ | `isMobileOS()` / UA-Regex | trifft genau die Ursache, deckt Android-Tablets mit ab; bestehendes Muster | 3, 4 |
| Wert 2 nur beim Lesen als 1 deuten, Storage nicht umschreiben | einmalige Migration | kein Schreibzeitpunkt nötig, kleiner Diff, gerätelokaler Speicher | 1, 4 |

## 5. UX

Optionen auf Android:
```
Vorher: [Im Popup] [In separatem Fenster] [Auf der Seite] [Aus]
Nachher: [Im Popup] [Auf der Seite] [Aus]      (gespeicherte 2 → „Im Popup“ markiert)
```
Popup auf Android bei Wert 2: vorher Sprung in Tab `popup.html?tab=…`, nachher Sheet wie bei „Im Popup“. Keine neuen Texte.

## 6. Risiken

| Risiko | Schwere | Umgang |
| --- | --- | --- |
| `chrome.windows` doch auf Fenix vorhanden | hoch (Fix wirkungslos) | K0 als Gate in Schritt 0 |
| Desktop-Pfad versehentlich geändert | mittel | Bedingung nur ergänzt; P3 |
| Bereits offener Lese-Tab `popup.html?tab=` auf Android | gering | läuft weiter (`init()`, kein `isPopup`), wird nur nicht mehr neu erzeugt; setzt weiter `readAloudTab` (`popup.js:28`), folgenlos, da `popout` auf Android nicht mehr läuft |

## 7. Nicht im Umfang

| Punkt | warum nicht | Auslöser zum Nachrüsten |
| --- | --- | --- |
| `returnTab`-Logik aus #22 für Lese-Tab | plattformneutral, schadet nicht; Pfad nur seltener | Aufräumen von #22 |
| Website `docs/` / Listing | erwähnt den Modus nicht plattformspezifisch | – |

## 8. Geklärte Fragen

keine (Issue-Text eindeutig).

## 9. Offene Punkte

| Nr | Punkt | Warum nicht klärbar | Folge, wenn anders |
| --- | --- | --- | --- |
| 1 | Annahme: Fenix (FF 160) hat kein `chrome.windows` in Erweiterungsseiten (MDN, Code-Kommentar `defaults.js:542`, Lucas' Beobachtung) | nur am Gerät messbar | K0-Gate in Schritt 0: Plan stoppen, Befund an Lucas |

## 10. Definition of Done

- [ ] Android: Option „In separatem Fenster“ nicht sichtbar; gespeicherter Wert 2 verhält sich wie „Im Popup“ (K1–K3)
- [ ] Messung nachher ≥ Ziel, Vorher/Nachher-Zahlen im Umsetzungsbericht
- [ ] Desktop-Firefox unverändert (K4, K5)
- [ ] Locales: keine neuen Texte
- [ ] Review ohne offene Blocker/High

# Teil B: Plan (Wie)

## 11. Pflichtlektüre

| Datei | Zeilen | Warum |
| --- | --- | --- |
| `js/popup.js` | 33-61, 145-180 | `popout`-Weiche, 1/2 gleich gerendert |
| `js/options.js` | 239-251 | Button-Handler + aktive Markierung |
| `options.html` | 76-84 | Button-Gruppe |
| `js/defaults.js` | 1, 541-560 | `brapi`, `!brapi.windows`-Muster |

## 12. Muster zum Übernehmen

QUELLE: `js/defaults.js:552-553`
```js
function updateWindow(windowId, details) {
  if (!brapi.windows) return Promise.resolve()
```
QUELLE: `js/options.js:264` (bedingte Sichtbarkeit per jQuery `toggle`)
```js
      $(".audio-playback-visible").toggle(settings.useEmbeddedPlayer ? true : false)
```

## 13. Schritte

### Schritt 0: Baseline messen

- [ ] erledigt
- **Umsetzen:** P0 (K0) auf Fenix und Desktop; P1–P3 auf unverändertem Stand, Werte in §4 eintragen. **Gate:** K0 Fenix ≠ `undefined` → stoppen, Befund an Lucas.
- **Prüfen:** §4 Baseline-Spalte gefüllt

### Schritt 1: `js/popup.js` – keine Auslagerung ohne Windows-API

- [ ] erledigt
- **Aktion:** UPDATE · **Datei:** `js/popup.js` · **Zeilen:** 34
- **Umsetzen:** `if (settings.showHighlighting == 2 && queryString.isPopup && brapi.windows) {` plus Kommentar eine Zeile: Firefox für Android hat keine Fenster, Modus 2 verhält sich dort wie 1.
- **Muster:** `js/defaults.js:543`
- **Falle:** `readAloudTab` nicht anfassen; `init()`-Zweig unverändert.
- **Prüfen:** `node --check js/popup.js`

### Schritt 2: `js/options.js` – Button ausblenden, Markierung abbilden

- [ ] erledigt
- **Aktion:** UPDATE · **Datei:** `js/options.js` · **Zeilen:** 240-250
- **Umsetzen:**
  - Im bestehenden `domReadyPromise.then` (Z. 240-245): `if (!brapi.windows) $('#show-highlighting button[data-value="2"]').hide()` (Kommentar wie Schritt 1).
  - In der Subscription (Z. 249): nach Ermitteln von `val` → `if (val == "2" && !brapi.windows) val = "1"` (dafür `const` → `let`).
- **Muster:** `js/options.js:264`
- **Falle:** Bootstrap-`btn-group` rundet erste/letzte Ecke per `:first-child`/`:last-child` – Button 2 ist mittig, Rundung bleibt korrekt; `css/options.css:204` (`.btn+.btn { margin-left:-1px }`) greift auch über den versteckten Button – Ecken und Abstände in P2 Sicht prüfen.
- **Prüfen:** `node --check js/options.js`

### Schritt 3: Abnahme

- [ ] erledigt
- **Umsetzen:** P1–P3 erneut, Nachher-Werte in Umsetzungsbericht.
- **Prüfen:** K1–K5 = Ziel

## 14. Prüfungen

| Prüfung | Befehl / Protokoll | Sichert ab |
| --- | --- | --- |
| Syntax | `node --check js/popup.js js/options.js` | — |
| Paket | `bash tools/build.sh` | XPI baut |
| Lint | `npx --yes web-ext lint -s . --ignore-files 'tools/**' 'docs/**'` | AMO-Validierung |
| Verhalten | P1–P3 (§4) | Fix wirkt, Desktop unverändert |

## 15. Umfang

2 Dateien, ~6 Zeilen. Regressionsrisiko Desktop minimal (Bedingungen nur bei fehlender Windows-API aktiv).

## Gegenlese

| Runde | Version | Urteil | Wichtigste Befunde |
| --- | --- | --- | --- |
| 1 | v1 | Go | MEDIUM: `chrome.windows`-Annahme in §9 · LOW: P0 auch im Popup-Kontext, Button-Abstände, `readAloudTab`-Halbsatz, Modell-Empfehlung – alle eingearbeitet |

## Umsetzungsbericht

**Datum:** 2026-11-19

| Aspekt | Plan | Tatsächlich | Grund |
| --- | --- | --- | --- |
| K0 Messkontext | Optionsseite + Popup-Tab | Background-Kontext (RDP) | RDP-Client hing danach; gleiche Extension-API-Oberfläche |
| Desktop P3/K4/K5 | echtes Desktop-Firefox | Optionsseite in Playwright-Firefox mit API-Stub (mit/ohne `windows`); Popup-Fenster nicht real gemessen | Fenster-Pfad nur um `&& brapi.windows` ergänzt (auf Desktop wahr) |
| K3 Button-Zahl | zählen | Lucas meldete nur „Im Popup“ aktiv; Zahl 3 nicht ausdrücklich genannt (Stub: 3) | – |

| KPI | Vorher | Nachher |
| --- | --- | --- |
| K0 `chrome.windows` Fenix | `undefined` | – |
| K1 Tab `popup.html?tab=` (Wert 2) | 3/3 | 0/3 |
| K2 Sheet + Wiedergabe | 0/3 (Tab) | 3/3 |
| K3 Optionen Android | 4 Buttons, „Separates Fenster“ aktiv | „Im Popup“ aktiv (Stub: 3 Buttons) |
| K5 Desktop Optionen (Stub) | 4 · 2 aktiv | 4 · 2 aktiv |

| Syntax/Build/Lint | Verhalten | Silent-Failure | Review |
| --- | --- | --- | --- |
| ✓ / ✓ / 0 Fehler, 12 Warnungen (vorbestehend) | Gerät ✓, Desktop-Optionen ✓ | n/a (keine neue Fehlerbehandlung) | 1 Runde, 2 Nits |

Entschieden vom Agenten (Umsetzung): keine.

Behobene Review-Befunde, nicht behobene mit Grund:
- Nit „`windows` evtl. partiell auf Fenix“: durch K0 (`undefined`) und Gerätetest widerlegt.
- Nit „Bedingung 3× dupliziert“: Helfer laut Plan §3 bewusst verworfen.
