# Issue #22 – Android: Artikel-Tab bleibt nach Start im Vordergrund (nicht der Player-Tab)

**Issue:** luc42ei/spotlight-reader#22 · **Upstream:** – · **Erstellt:** 2026-11-18
**Status:** Go (v3) · **Branch:** `chore/22-android-artikel-tab`
**Umsetzung mit:** Opus – Ursache erst am Gerät zu ermitteln (Diagnose-Gate Fall A/B/C), Fenix-Tab-Verhalten unbelegt

# Teil A: Spec (Was/Warum)

## 1. Problem

Issue: „Beim Start von Spotlight Reader auf dem Handy rückt der Player-Tab (`player.html`) in den Vordergrund. Man muss selbst zurück zum Tab wechseln, der gerade vorgelesen wird.“ (Pixel 7a, Firefox 160, v3.5.0)

Präzisierung (Issue-Kommentar 2026-11-18): Nach dem Start soll **der Tab sichtbar sein, in dem der vorgelesene Text zu sehen ist**:
- **„Auf der Seite“** (`showHighlighting == 3`, In-Page) → Artikel-Tab.
- **„Im Popup anzeigen“** (`== 1`, Text im Erweiterungs-Popup; auf Android Vollbild-Sheet über dem Artikel) → Popup bleibt sichtbar, falls Fenix das zulässt; mindestens Artikel-Tab aktiv.
- **„In separatem Fenster anzeigen“** (`== 2`) → auf Android öffnet `popout` statt eines Fensters einen Tab `popup.html?tab=<id>` (`js/popup.js:39-58`, `createWindow` → `createTab`, `js/defaults.js:541-542`) → dieser Lese-Tab.

Lucas' „Pop-up-Modus“ kann `1` oder `2` meinen → beide werden gemessen.

Start am Handy in beiden Modi über den Spotlight-Reader-Eintrag im Firefox-Menü (Browser-Action-Popup bzw. im Pop-up-Modus Play im Lese-Tab). Desktop unverändert; Autoplay-Freigabe-Dialog funktioniert weiter.

## 2. Ursache / Ausgangslage

Einziger Codepfad, der den Player-Tab beim Start aktiviert: `requestAudioPlaybackPermission` (einmal pro Player-Tab, vor dem ersten Chunk; einziger Aufrufer `playAudio`, `js/player.js:452-454`).

QUELLE: `js/player.js:465-485`
```js
  async function request() {
    const thisTab = await brapi.tabs.getCurrent()
    const prevTab = await brapi.tabs.query({windowId: thisTab.windowId, active: true}).then(tabs => tabs[0])
    await brapi.tabs.update(thisTab.id, {active: true})
    ...
    audioUnlocked = true
    dialog.hide()
    if (prevTab) await brapi.tabs.update(prevTab.id, {active: true})
  }
```

Player-Tab entsteht in `createPlayerTab` (`js/events.js:586-595`, `active: false`, `index: 0`, Pinnen scheitert auf Android). Aufrufer: nur `injectPlayer` (`js/events.js:567`, `:571`), aufgerufen von `playTab` (`:333`), `playText` (`:199`), Piper (`:498`). Embedded-Player (iframe im Artikel-Tab, `js/events.js:548-584`) nicht betroffen: dort ist `thisTab` der sichtbare Tab.

**Hypothesen (am Gerät zu messen, Schritt 0).** Wiedergabe startet am Handy normal → `request()` läuft bis zum Ende (sonst `granted = null`, Fehler). Also:
- **A** – Rücksprungziel falsch: `prevTab` ist der Player-Tab selbst oder fehlt (Fenix hat den Player-Tab schon vor `request()` aktiviert, z. B. `tabs.create` ignoriert `active: false`; oder Fenix-Fenstermodell). Indiz zusätzlich: `thisTab.active == true` beim Eintritt.
- **A′** – `prevTab` ist ein dritter Tab (weder Player noch sichtbarer Text-Tab).
- **B** – `prevTab` stimmt, Rückwechsel erfüllt, wirkt aber nicht.
- **C** – Rückwechsel wirkt, ein späteres Ereignis holt den Player-Tab wieder nach vorn.
- **X** – `tabs.getCurrent()` liefert `undefined` → `thisTab.windowId` wirft. Widerspricht „Wiedergabe startet“, nur der Vollständigkeit halber.

Unabhängig von Android: Schließt der Nutzer den Freigabe-Dialog (`.close` → reject) oder schlägt `playSilence` anders fehl, entfällt der Rückwechsel ganz (kein `finally`, `js/player.js:469-481`).

## 3. Lösung

- **Ansatz (Fall A/A′):** Der Background merkt sich beim Anlegen des Player-Tabs, welcher Tab gerade sichtbar ist, und gibt ihn dem Player-Tab mit; der Player kehrt dorthin zurück.
  1. `createPlayerTab()` in `js/events.js`: vor `tabs.create` `const returnTab = await getActiveTab()` (`js/defaults.js:487-492`); URL `player.html?autoclose` + `&returnTab=<id>`, wenn bekannt. „Auf der Seite“/„Im Popup“ → Artikel-Tab (Sheet ist kein Tab); „Separates Fenster“ auf Android → Lese-Tab (dort wurde Play gedrückt); Desktop → aktiver Tab wie heute.
  2. `request()` in `js/player.js`: Rücksprungziel = `prevTab.id`, wenn `prevTab` existiert und `!= thisTab.id`; sonst `Number(queryString.get("returnTab"))`, wenn gesetzt und `!= thisTab.id`; sonst keiner. Desktop: `prevTab` ist der sichtbare Tab ≠ Player → Pfad unverändert.
  3. Rückwechsel in `finally` (auch nach Dialog-„×“ oder Fehler); Fehler dabei nur `console.warn` (Tab evtl. geschlossen), damit er die Freigabe nicht kippt.
- **Fall A′:** wie A, sofern `returnTab` den richtigen Tab trifft (D2 zeigt es); `prevTab` hat dann Vorrang und wäre falsch → in diesem Fall Reihenfolge umdrehen (`returnTab` vor `prevTab`) und im Umsetzungsbericht vermerken. Das gilt dann auch auf Desktop → P2 Schritt 4 Pflicht.
- **Fall B/C/X:** keine Umsetzung nach diesem Plan; Messbefund an Lucas, neuer Plan. Verzögerter/wiederholter Rückwechsel wäre ein Pflaster.
- **Begründung:** „Der beim Start sichtbare Tab“ ist genau die Issue-Absicht für beide Modi; der Background kennt ihn ohne Raten, bevor der Player-Tab existiert. `request()` läuft im Normalfall einmal pro Player-Tab, direkt nach dessen Anlage → Wert aus der URL ist aktuell (Ausnahme siehe Bekannte Grenzen). Keine Permission, kein Server-Kontakt, ~15 Zeilen in zwei Dateien.
- **Pflaster-Check:** (1) Absicht beider Modi erfüllt. (2) Kein späterer Umbau. (3) Bestehendes Muster: Query-Parameter am Player-Tab (`autoclose`, `opener`, `js/player.js:105`, `:145`), `getActiveTab` wie `playText`; `prevTab`-Logik bleibt, `returnTab` greift nur, wo sie leer/selbstbezüglich ist.
- **Verworfen:**
  - Fallback auf `sourceUri` (`contentscript:<id>`) – zeigt im Pop-up-Modus auf den Artikel, nicht auf den Lese-Tab; verfehlt Absicht.
  - Player-Tab gar nicht aktivieren (play() im Hintergrund probieren) – Desktop-Firefox hält `play()` in Hintergrund-Tabs bis zum Vordergrund an, Promise hängt → Timeout-Raten; gefährdet Desktop (Prinzip 3).
  - Embedded-Player auf Android erzwingen (kein Player-Tab) – Wiedergabe-Keepalive bei Sperre (#20) und Piper hängen am Player-Tab; Embedded scheitert in Inkognito/CSP-Seiten; großer Verhaltenswechsel (Prinzip 3/4).
  - `isMobileOS()`-Sonderzweig – Lösung ist plattformneutral.

## 4. Messung (Baseline = Abnahme)

Gerät: Pixel 7a, Android 17, Firefox 160 (wie #20). Desktop: Firefox Linux. Testseite: `https://de.wikipedia.org/wiki/Geschichte_Berlins`. Embedded-Player in den Optionen **aus**. Vor jedem Lauf Player-Tab schließen (frischer Tab → `request()` läuft erneut). Maßgeblich ist **D1** (aktiver Tab laut `tabs.query`), Sichtprüfung erst nach Schließen des Menü-/Popup-Sheets.

| KPI | Methode | Baseline | Ziel |
| --- | --- | --- | --- |
| K1 Android, In-Page-Modus: Artikel-Tab aktiv ~3 s nach Start | P1a, 5 Läufe, D1 | ? / 5 | 5 / 5 |
| K2 Android, „Separates Fenster“: Lese-Tab (`popup.html?tab=…`) aktiv ~3 s nach Play | P1b, 5 Läufe, D1 | ? / 5 | 5 / 5 |
| K2b Android, „Im Popup“: Popup-Sheet noch sichtbar bzw. nach Schließen Artikel-Tab aktiv | P1c, 5 Läufe, Sicht + D1 | Sheet ?/5, Artikel ?/5 | Artikel 5/5; Sheet = Baseline oder besser |
| K3 Diagnose: Fall A/A′/B/C/X | D2 (Diagnose-Log) | ? | – (Gate) |
| K4 Desktop, In-Page + Tastenkürzel: Artikel-Tab aktiv | P2, je 3 Läufe | ? / 6 | = Baseline |
| K5 Autoplay-Dialog Desktop: „Erlauben“ → Wiedergabe + Rückkehr; „×“ → Fehlertext + Rückkehr | P2 Schritt 3 | Erlauben ?; × ? | Erlauben ok; × kehrt zurück |
| K6 Wiedergabe startet und läuft (erste 3 Chunks), Highlight wie gewohnt | P1/P2 | ja | ja |

## Entschieden vom Agenten

| Entscheidung | Verworfen | Warum | Prinzip |
| --- | --- | --- | --- |
| Rücksprung auf „beim Start sichtbaren Tab“ (`returnTab` aus Background) | `sourceUri`-Artikel-Tab | deckt Pop-up-Modus (Lese-Tab) mit ab | 3 Funktion |
| Rückwechsel auch nach Dialog-„×“/Fehler (`finally`) | nur Erfolgsfall | Absicht „Tab mit Text danach sichtbar“; Dialog ist dann schon zu, Fehlertext kommt im Popup | 3 Funktion |
| Fall B/C/X nicht vorab planen | Retry/Verzögerung | Pflaster; Ursache erst messen | 4 Einfachheit |
| Branch-Präfix `chore/` | `fix/` | Issue ohne Label, Skill-Regel | – |

## 6. Risiken

| Risiko | Schwere | Umgang |
| --- | --- | --- |
| Diagnose zeigt Fall B/C/X | mittel | Umsetzung stoppt nach Schritt 0, Befund an Lucas |
| `getActiveTab()` liefert auf Fenix nichts/Falsches (`lastFocusedWindow`) | mittel | D2 loggt `returnTab`; falsch → Befund an Lucas statt Umsetzung |
| Desktop: `finally` kehrt nach „×“ zurück, Dialog-Hinweis nicht mehr sichtbar | niedrig | gewollt; Popup zeigt Fehlertext (P2 Schritt 3) |
| `getActiveTab()` vor `tabs.create` verzögert Start | niedrig | ein lokaler API-Aufruf (ms) |

**Bekannte Grenzen (bestehend, nicht verschlimmert):**
- Stop aus dem Popup bei offenem Freigabe-Dialog lässt das Dialog-Promise hängen → `finally` läuft nie, Player-Tab bleibt vorn (heute identisch).
- Nach „×“/Fehler setzt `granted = null` (`js/player.js:463`); beim nächsten Vorlesen im selben Player-Tab läuft `request()` erneut, `returnTab` kann dann veraltet/geschlossen sein. Harmlos: `prevTab` hat Vorrang, Fehler nur `console.warn`.

## 7. Nicht im Umfang

| Punkt | warum nicht | Auslöser zum Nachrüsten |
| --- | --- | --- |
| `managePiperVoices` aktiviert Player-Tab (`js/player.js:511-522`) | gewollt, Verwaltung braucht den Tab | – |
| Piper: `injectPlayer()` ohne Tab (`js/events.js:498`) bekommt ebenfalls `returnTab` | unschädlich, `managePiperVoices` aktiviert den Player-Tab danach selbst | – |
| Opera-/Options-eigene Player-Tabs (`js/popup.js:126`, `js/options.js:612`) | nicht Firefox/Android | – |

## 8. Geklärte Fragen

| Frage | Antwort | Datum |
| --- | --- | --- |
| Gerät/Setup | Pixel 7a, Android 17, Firefox 160, USB-Debugging + `web-ext run -t firefox-android` (aus #20) | 2026-11-18 |
| Welcher Tab soll nach Start sichtbar sein? | der Tab mit dem vorgelesenen Text: In-Page → Artikel, Pop-up-Modus → der Tab, in dem der Text angezeigt wird (Issue-Kommentar) | 2026-11-18 |

## 9. Offene Punkte

| Nr | Punkt | Warum nicht klärbar | Folge, wenn anders |
| --- | --- | --- | --- |
| 1 | Welcher Fall (A/A′/B/C/X) liegt auf Fenix vor? | nur am Gerät | B/C/X → Stopp nach Schritt 0, neuer Plan |
| 2 | Wirkt `tabs.update(id, {active: true})` aus einem `moz-extension://`-Tab auf Fenix? | nur am Gerät (D2) | nein → Fall B |
| 3 | Liefert `getActiveTab()` im Background auf Fenix den sichtbaren Tab? | nur am Gerät (D2) | nein → Befund an Lucas |

## 10. Definition of Done

- [ ] K1, K2 = 5/5, K2b Artikel 5/5 am Pixel 7a
- [ ] K4 = Baseline, K5 wie Ziel, K6 ja
- [ ] Vorher/Nachher-Zahlen im Umsetzungsbericht
- [ ] Diagnose-Patch nicht committet (`grep -rn SR22 js/` leer)
- [ ] Review ohne offene Blocker/High

# Teil B: Plan (Wie)

## 11. Pflichtlektüre

| Datei | Zeilen | Warum |
| --- | --- | --- |
| `js/player.js` | 1-5, 100-116, 341-364, 452-486 | `queryString`, `autoclose`, `audioUnlocked`, `request()` |
| `js/events.js` | 195-201, 308-335, 548-595 | Startpfade → `injectPlayer` → `createPlayerTab` |
| `js/popup.js` | 25-58 | Pop-up-Modus, `popout`, `readAloudTab` |
| `js/defaults.js` | 487-505, 541-560 | `getActiveTab`, `createWindow`-Android-Fallback |
| `player.html` | 64-80 | Freigabe-Dialog |
| `tools/issues/20-android-lockscreen.md` | §4, §13 Schritt 0 | Geräte-Setup, `web-ext run`, Remote-Konsole |

## 12. Muster zum Übernehmen

QUELLE: `js/player.js:3`, `:105` (Query-Parameter am Player-Tab)
```js
var queryString = new URLSearchParams(location.search)
...
if (queryString.has("autoclose")) {
```

QUELLE: `js/events.js:197-199` (`getActiveTab` im Background)
```js
async function playText(text, opts) {
  const hasPlayer = await stop().then(res => res == true, err => false)
  if (!hasPlayer) await injectPlayer(await getActiveTab())
```

QUELLE: `js/events.js:592-593` (Fehler bei Tab-Aufruf nur warnen)
```js
  try { await brapi.tabs.update(tab.id, {pinned: true}) }
  catch (err) { console.warn(err) }
```

## 13. Schritte

### Schritt 0: Baseline + Diagnose

- [ ] erledigt
- **Umsetzen:** P1a–P1c (mit Diagnose-Patch) und P2 auf `master`-Code; Werte in §4.
- **Prüfen:** §4 Baseline-Spalte vollständig, Fall notiert. **Gate:** Fall A/A′ und D2 zeigt `getActiveTab()` = sichtbarer Tab → Schritt 1. Sonst Befund + Logauszug an Lucas, Patch verwerfen, Stopp.

**Diagnose-Patch (temporär, nie committen):** Player-Logs gehen sonst verloren (`request()` läuft, bevor die Remote-Konsole hängt) → in `storage.local` puffern:
- Helfer in `js/defaults.js` (von Background und Player geladen), ein Key pro Eintrag (kein get→set-Wettlauf zwischen Kontexten): `function sr22(...a){ console.info("SR22", ...a); brapi.storage.local.set({["sr22_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)]: [location.pathname, JSON.stringify(a)]}) }`
- `js/events.js` `createPlayerTab`: vor `tabs.create` `sr22("active before create", (await getActiveTab() || {}).id)`; nach `create` `sr22("created", tab.id, tab.active)`; einmalig `brapi.tabs.onActivated.addListener(i => sr22("activated", i.tabId))`.
- `js/player.js` `request()`: `sr22("enter", thisTab && [thisTab.id, thisTab.active, thisTab.windowId], prevTab && [prevTab.id, prevTab.url])`; nach jedem `tabs.update` `sr22("update ok"/"update err", id, String(err))`.
- Auslesen in der Background-Konsole: `browser.storage.local.get(null).then(s => console.table(Object.keys(s).filter(k => k.startsWith("sr22_")).sort().map(k => [k, ...s[k]])))`; vor jedem Lauf dieselben Keys per `browser.storage.local.remove([...])` löschen. Nach Schritt 0: `git checkout -- js/`.

**D2 – Fall-Zuordnung:**

| Log-Befund | Fall | Gate |
| --- | --- | --- |
| `enter` wirft/`thisTab` fehlt | X | Stopp |
| `prevTab.id == thisTab.id` oder `prevTab` fehlt, oder `thisTab.active` schon `true` | A | weiter |
| `prevTab` ≠ Player und ≠ sichtbarer Text-Tab | A′ | weiter, Reihenfolge `returnTab` vor `prevTab` (§3) |
| `prevTab` = sichtbarer Tab, `update ok`, D1 zeigt Player aktiv, kein späteres `activated` auf Player | B | Stopp |
| späteres `activated` auf Player nach Rückwechsel | C | Stopp |
| `active before create` ≠ sichtbarer Text-Tab | – | Stopp (Offener Punkt 3) |

**P1 – Android (Pixel 7a):**
1. `adb devices`; Firefox „Remote-Debugging über USB“ an; AMO-Version deaktivieren; `npx --yes web-ext run -t firefox-android --android-device <id> --firefox-apk org.mozilla.firefox` (Baseline: `master` + Diagnose-Patch; Abnahme: Branch ohne Patch).
2. Desktop `about:debugging` → Gerät → Spotlight Reader „Untersuchen“ (Background-Konsole).
3. **P1a:** Optionen → Hervorhebung „Auf der Seite“. Testseite öffnen, Player-Tab schließen. Firefox-Menü → Spotlight Reader → Play; Sheet schließen (Zurück). Nach ~3 s **D1** in Background-Konsole: `browser.tabs.query({}).then(t => t.map(x => [x.id, x.active, x.url.slice(0, 50)]))` → aktiv = Artikel? (K1). Baseline: D2 auslesen. 5×.
4. **P1b:** Optionen → Hervorhebung „In separatem Fenster anzeigen“. Testseite, Player-Tab schließen. Firefox-Menü → Spotlight Reader → Lese-Tab öffnet sich → dort Play. Nach ~3 s D1 → aktiv = `popup.html?tab=…`? (K2). Baseline: D2. 5×.
5. **P1c:** Optionen → Hervorhebung „Im Popup anzeigen“. Testseite, Player-Tab schließen. Firefox-Menü → Spotlight Reader → Play; nach ~3 s notieren: Popup-Sheet mit Text noch sichtbar? Dann Sheet schließen, D1 → aktiv = Artikel? (K2b). Baseline: D2. 5×.
6. K6 nebenbei (Ton, Hervorhebung).

**P2 – Desktop (Firefox Linux, Add-on temporär über about:debugging):**
1. Hervorhebung „Auf der Seite“. Player-Tab schließen, Testseite, Toolbar-Popup → Play → aktiver Tab nach 3 s (3×); dasselbe mit Tastenkürzel (3×) → K4.
2. K6: Wiedergabe läuft, Highlight wie gewohnt.
3. K5: `about:preferences#privacy` → Autoplay „Audio und Video blockieren“; Player-Tab schließen; Play → Dialog im Player-Tab → „Erlauben“ → Wiedergabe + aktiver Tab. Wiederholen mit „×“ → aktiver Tab notieren, dann Toolbar-Popup **erneut öffnen** (schließt sich beim Tabwechsel) → Fehlertext. Einstellung zurücksetzen.
4. Nur bei Fall A′ (Reihenfolge getauscht), Baseline vs. Branch: Hervorhebung „In separatem Fenster anzeigen“ → Play im Lesefenster → aktives Fenster/Tab nach 3 s; „Auf der Seite“ + Tabwechsel direkt nach Play (vor erstem Ton) → aktiver Tab. Je 2 Läufe, muss Baseline entsprechen.

### Schritt 1: `js/events.js` – `returnTab` an Player-Tab

- [ ] erledigt
- **Aktion:** UPDATE · **Datei:** `js/events.js` · **Zeilen:** 586-595
- **Umsetzen:** vor `tabs.create`: `const returnTab = await getActiveTab()`; `url: brapi.runtime.getURL("player.html?autoclose" + (returnTab ? "&returnTab=" + returnTab.id : ""))`. Kommentar: Firefox für Android aktiviert den Player-Tab evtl. trotz `active: false`; der Player kehrt dann zu diesem Tab zurück (#22).
- **Muster:** `js/events.js:199`
- **Falle:** `getActiveTab` (`js/defaults.js:487-492`) rejectet nie, liefert höchstens `undefined` → kein `.catch` nötig, `returnTab ?` prüfen. `autoclose` bleibt erster Parameter ohne Wert (`queryString.get("autoclose")` ist `""` ≠ `"long"`, Verhalten gleich).
- **Prüfen:** `node --check js/events.js`

### Schritt 2: `js/player.js` – Rücksprungziel + `finally` in `request()`

- [ ] erledigt
- **Aktion:** UPDATE · **Datei:** `js/player.js` · **Zeilen:** 457-485
- **Umsetzen:**
  - Nach `prevTab`: `const returnTabId = prevTab && prevTab.id != thisTab.id ? prevTab.id : Number(queryString.get("returnTab")) || null`; zusätzlich `null`, wenn `== thisTab.id`. (Fall A′: Reihenfolge laut §3 tauschen.)
  - Alles ab `tabs.update(thisTab.id, …)` bis `dialog.hide()` in `try { … } finally { … }`; im `finally`: `dialog.hide()`; `if (returnTabId) await brapi.tabs.update(returnTabId, {active: true}).catch(console.warn)`. `audioUnlocked = true` bleibt im `try` nach erfolgreichem `playSilence`. Inneres `.finally(() => dialog.hide())` entfällt (nur ein Hide-Pfad).
  - Kommentar über `request()` (`:457-460`) um einen Satz ergänzen: Rücksprung zum beim Start sichtbaren Tab, auch wenn Firefox für Android den Player-Tab schon aktiviert hat (#22).
- **Falle:** Kein `catch` im `try` – Dialog-Fehler muss weiter geworfen werden, damit `granted = null` greift (`:463`). Embedded-Player: kein `returnTab`-Parameter, `prevTab` = `thisTab` → kein Rückwechsel (wie heute: dort aktiviert `update(thisTab)` den ohnehin sichtbaren Tab).
- **Prüfen:** `node --check js/player.js`; Code-Lesung: Desktop-Pfad (`prevTab` ≠ Player) unverändert.

### Schritt 3: Abnahme

- [ ] erledigt
- **Umsetzen:** P1a–P1c (ohne Diagnose-Patch, nur D1) und P2 auf dem Branch; Werte in Umsetzungsbericht.
- **Prüfen:** K1, K2 = 5/5; K2b Artikel 5/5; K4 = Baseline; K5 wie Ziel; K6 ja.

## 14. Prüfungen

| Prüfung | Befehl / Protokoll | Sichert ab |
| --- | --- | --- |
| Syntax | `node --check js/events.js js/player.js` | — |
| Kein Diagnose-Rest | `git diff master --stat` → nur `js/events.js`, `js/player.js`, Plan; `grep -rn SR22 js/` leer | Patch nicht committet |
| Paket | `bash tools/build.sh` | XPI baut |
| Lint | `npx --yes web-ext lint -s . --ignore-files 'tools/**' 'docs/**'` | AMO-Validierung |
| Verhalten | P1a–P1c, P2 | K1–K6 |

## 15. Umfang

2 Dateien (`js/events.js`, `js/player.js`), ~15–20 Zeilen. Regressionsrisiko niedrig: Desktop-Pfad identisch bis auf `finally`-Rückkehr nach „×“/Fehler.

## Gegenlese

| Runde | Version | Urteil | Wichtigste Befunde |
| --- | --- | --- | --- |
| 1 (Opus) | v1 | No-Go | In-Page-Start auf Android existiert nicht (→ Lucas: „In-Page“/„Pop-up“ = Hervorhebungs-Modi; Ziel = Tab mit Text, Lösung auf `returnTab` umgestellt); D2-Fälle A′/X ergänzt; Sheet vor Sichtprüfung schließen; Player-Logs in `storage.local` puffern; LOW: §3 P.4 gestrichen, Embedded verworfen begründet, Stop-bei-Dialog als bekannte Grenze, Zeilen korrigiert; `document.js:33`-Parser entfällt (kein `sourceUri` mehr) |
| 2 (Opus, voll – Lösung geändert) | v2 | Go | MEDIUM: Diagnose-Log-Wettlauf (→ ein Key pro Eintrag); Fall A′ wirkt auf Desktop (→ P2 Schritt 4); LOW: „nie veraltet“ → Bekannte Grenze, Popup-Fehlertext erst nach Neuöffnen, `.catch` unnötig, Piper-Pfad in §7 — alle eingearbeitet |

## Umsetzungsbericht

Nach der Umsetzung ausfüllen. **Datum:** …

| Aspekt | Plan | Tatsächlich | Grund |
| --- | --- | --- | --- |

| KPI | Vorher | Nachher |
| --- | --- | --- |

| Syntax/Build/Lint | Verhalten | Silent-Failure | Review |
| --- | --- | --- | --- |

Entschieden vom Agenten (Umsetzung): „keine“ oder Tabelle (Entscheidung · Verworfen · Warum · Prinzip).

Behobene Review-Befunde, nicht behobene mit Grund:
