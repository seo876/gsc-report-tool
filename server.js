// SELLWERK DIY-Generator – Proxy-Server
// Node 18+ (nutzt globales fetch). Läuft z. B. auf Render als Web Service.
//
// Aufgaben:
//  1. Lädt die Kunden-Website (und optional Unterseiten) serverseitig (kein CORS-Problem im Browser).
//  2. Extrahiert deterministisch die "Vorher"-Daten: Meta-Titel/-Beschreibung, H1/H2-Struktur,
//     Bilder inkl. Alt-Text, Buttons, Kontaktdaten, Farb-/Schrift-Hinweise.
//  3. Schickt genau EINEN Prompt an die Claude API, der nur die "Nachher"-Vorschläge /
//     neuen Inhalte erzeugt (Meta, Texte, FAQ, CTA-Design, Alt-Texte, Button-Texte,
//     interne Verlinkung, Rechtschreibkorrektur, Local Schema, Unterseiten-Check).
//  4. Führt extrahierte Vorher-Daten + KI-Nachher-Daten zu einem JSON zusammen, das 1:1 dem
//     Format entspricht, das SELLWERK_DIY_Generator.html über applyImportedData() erwartet.
//
// Der Anthropic API-Key wird NIE an den Browser/das Tool weitergegeben – er lebt ausschließlich
// als Server-Umgebungsvariable (ANTHROPIC_API_KEY).

"use strict";

const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");
const probeImageSize = require("probe-image-size");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const PORT = process.env.PORT || 3000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_SUBPAGES = 6;
const MAX_IMAGES = 8;
const MAX_SECTIONS = 15;
const MAX_LINKS_CHECK = 30;
const LINK_CHECK_TIMEOUT_MS = 8000;
const LINK_CHECK_CONCURRENCY = 6;
const ICON_SIZE_PROBE_TIMEOUT_MS = 5000;
const ICON_MAX_SIZE_PX = 32;

/* =========================================================================
   1. Seiten-Fetch
   ========================================================================= */

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; SellwerkDIYBot/1.0; +https://www.sellwerk.de)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!resp.ok) {
      throw new Error("HTTP " + resp.status + " beim Laden von " + url);
    }
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

function absolutize(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).href;
  } catch (e) {
    return maybeRelative || "";
  }
}

// Prüft den HTTP-Status EINES Links, ohne bei 404 o. Ä. eine Exception zu werfen (im Gegensatz zu
// fetchHtml). Versucht zuerst HEAD (schneller/schont den Server), fällt bei Fehlern/fehlender
// HEAD-Unterstützung auf GET zurück. Netzwerkfehler/Timeouts werden als ok:true zurückgegeben
// (status: null) statt fälschlich als "404" gemeldet – dafür gibt es zu viele harmlose Ursachen
// (Bot-Blocker, Rate-Limiting, DNS-Hänger), um sie dem Kunden als defekten Link zu präsentieren.
async function checkLinkStatus(url) {
  const tryOnce = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; SellwerkDIYBot/1.0; +https://www.sellwerk.de)",
        },
      });
      return resp.status;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let status = await tryOnce("HEAD");
    // Manche Server lehnen HEAD grundsätzlich ab (405/501) -> zur Sicherheit mit GET nachprüfen,
    // bevor daraus fälschlich "defekt" wird.
    if (status === 405 || status === 501) status = await tryOnce("GET");
    return { url, status, ok: true };
  } catch (e) {
    return { url, status: null, ok: false };
  }
}

// Prüft eine Liste interner Links mit begrenzter Nebenläufigkeit (kein Promise.all über alle auf
// einmal, um die Kundenseite nicht mit 20+ gleichzeitigen Requests zu belasten) und liefert nur
// die zurück, die WIRKLICH mit 404/410 antworten – alles andere (200, Weiterleitungen, 403, 5xx,
// Timeouts) wird bewusst NICHT als "defekt" gemeldet, um keine falschen Befunde zu erzeugen.
async function findBrokenLinks(links) {
  const queue = (links || []).slice(0, MAX_LINKS_CHECK);
  const broken = [];
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const current = queue[idx++];
      const result = await checkLinkStatus(current.url);
      if (result.ok && (result.status === 404 || result.status === 410)) {
        broken.push({ url: current.url, text: current.text || "", status: result.status });
      }
    }
  }
  const workers = [];
  for (let i = 0; i < LINK_CHECK_CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  return broken;
}

// Geocoding (Adresse -> Latitude/Longitude) über die kostenlose OpenStreetMap-Nominatim-API.
// Wird nur als Fallback genutzt, wenn die Kundenseite selbst noch keine Geo-Koordinaten im
// eigenen Schema hinterlegt hat. Liefert nur echte, nachschlagbare Koordinaten – keine Schätzung.
async function geocodeAddress(street, zip, city, country) {
  if (!zip && !city) return null;
  const query = [street, zip, city, country || "Deutschland"].filter(Boolean).join(", ");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(query),
      {
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; SellwerkDIYBot/1.0; +https://www.sellwerk.de)",
        },
      }
    );
    if (!resp.ok) return null;
    const results = await resp.json();
    if (!Array.isArray(results) || !results[0]) return null;
    const lat = parseFloat(results[0].lat);
    const lon = parseFloat(results[0].lon);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    return { lat: String(lat), lng: String(lon) };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================================
   2. Deterministische Extraktion ("Vorher"-Daten)
   ========================================================================= */

// Erweiterte Erkennung reiner UI-/Zier-Icons anhand des Dateinamens (Logos, Social-Icons, Pfeile,
// Telefon-/Mail-Symbole usw.) – bewusst nur EIN Signal von mehreren, siehe probeIsTinyImage() für
// die verlässlichere, größenbasierte Prüfung direkt am Bild selbst.
const ICON_FILENAME_PATTERN =
  /logo|icon|sprite|favicon|phone|telefon|\btel\b|mail|email|arrow|pfeil|chevron|caret|check|haken|close|schlie(ss|ß)en|cart|warenkorb|search|suche|whatsapp|instagram|facebook|linkedin|youtube|xing|twitter|social|star|bewertung|play|print|drucken|share|teilen|plus|minus|pin|marker|standort|clock|uhr|payment|zahlung|visa|mastercard|paypal/i;

// Der Icon-Filter darf NUR den Dateinamen prüfen, nicht die ganze URL: Pfade wie
// "/wp-content/uploads/..." oder Domains wie "cdn.social.example" enthalten sonst Treffer-Wörter und
// würden JEDES Bild einer Seite als Icon verwerfen.
function imageFileName(src) {
  try {
    return decodeURIComponent(new URL(src, "http://x/").pathname.split("/").pop() || "");
  } catch (e) {
    return String(src || "").split("?")[0].split("/").pop() || "";
  }
}

// Profilbilder/Sterne aus Bewertungs-Widgets (Trustindex, Google, Gravatar …) sind keine
// Inhaltsbilder der Kundenseite und sollen nie als "Alt-Text fehlt/optimieren" auftauchen.
const WIDGET_IMAGE_HOST_PATTERN =
  /googleusercontent\.com|trustindex\.io|gravatar\.com|ggpht\.com|fbcdn\.net|cdninstagram\.com|ytimg\.com/i;
const WIDGET_IMAGE_ALT_PATTERN = /profile picture|profilbild|google star|^star \d/i;

// Prüft die TATSÄCHLICHE Pixelgröße eines Bildes über die Datei-Header (lädt nur die dafür nötigen
// ersten Bytes, nicht das ganze Bild). Zuverlässiger als der Dateiname, weil viele Icons beliebig
// benannt sind (Hashes, "IMG_1234" etc.). Bei jedem Fehler (Timeout, kein Bild, CORS o. Ä.) wird
// bewusst "kein Icon" angenommen – ein echtes Content-Bild lieber einmal zu viel melden als ein
// wichtiges Bild fälschlich zu unterschlagen.
async function probeIsTinyImage(url) {
  try {
    const result = await probeImageSize(url, { timeout: ICON_SIZE_PROBE_TIMEOUT_MS });
    return result.width <= ICON_MAX_SIZE_PX && result.height <= ICON_MAX_SIZE_PX;
  } catch (e) {
    return false;
  }
}

async function extractPageData(html, pageUrl) {
  const $ = cheerio.load(html);

  const title = ($("title").first().text() || "").trim();
  const metaDesc = ($('meta[name="description"]').attr("content") || "").trim();
  const themeColor = ($('meta[name="theme-color"]').attr("content") || "").trim();

  // Überschriftentext mit <br> als Leerzeichen ("Wobei wir Sie<br>unterstützen." -> "Wobei wir Sie
  // unterstützen." statt "Sieunterstützen."), Whitespace normalisiert.
  const headingText = (node) => {
    const c = node.clone();
    c.find("br").replaceWith(" ");
    return c.text().replace(/\s+/g, " ").trim();
  };

  const h1s = [];
  $("h1").each((_, el) => {
    const t = headingText($(el));
    if (t) h1s.push(t);
  });

  // Abschnitte: über die Dokumentreihenfolge extrahiert statt über direkte Geschwister-Elemente.
  // Grund: Überschrift und zugehöriger Text stecken in der Praxis sehr oft in getrennten
  // Wrapper-Divs (z. B. <div><h2>...</h2></div><div><p>...</p></div>) und sind dadurch keine
  // direkten Geschwister – eine reine .next()-Geschwister-Heuristik übersieht solche Abschnitte
  // komplett bzw. liefert leeren Text. Zusätzlich wird der hervorgehobene Einleitungstext direkt
  // unter der H1 (Hero-Bereich, oft ganz ohne eigene H2) als erster Abschnitt mit aufgenommen.
  // H3-Überschriften (z. B. Karten/Grid-Elemente wie "Leistungen im Überblick") zählen ebenfalls
  // als eigene Abschnittsgrenzen, damit solche Inhalte nicht kommentarlos im vorherigen
  // Abschnitt untergehen.
  //
  // Zusätzlich werden Abschnitte übersprungen, die im Seiten-Builder erkennbar und eindeutig auf
  // ALLEN Geräten ausgeblendet sind (inline style="display:none"/"visibility:hidden", oder bei
  // Elementor die Kombination aus elementor-hidden-desktop + -tablet + -mobile). Solcher Content
  // ist im Quellcode vorhanden, aber für echte Besucher und Google nirgends sichtbar – er würde in
  // der Kunden-Anleitung sonst fälschlich als "aktueller Text auf der Seite" dargestellt.
  function isHiddenEverywhere(node) {
    let cur = node;
    while (cur && cur.length) {
      const style = (cur.attr("style") || "").toLowerCase();
      if (/display\s*:\s*none/.test(style) || /visibility\s*:\s*hidden/.test(style)) return true;
      const cls = " " + (cur.attr("class") || "") + " ";
      if (
        cls.includes(" elementor-hidden-desktop ") &&
        cls.includes(" elementor-hidden-tablet ") &&
        cls.includes(" elementor-hidden-mobile ")
      ) {
        return true;
      }
      cur = cur.parent();
    }
    return false;
  }

  const sections = [];
  {
    let order = 0;
    const orderIndex = new Map();
    (function walk(el) {
      order++;
      orderIndex.set(el, order);
      $(el)
        .contents()
        .each((_, child) => {
          if (child.type === "tag") walk(child);
        });
    })($("body").get(0) || $.root().get(0));

    const skipAncestors = "header, nav, footer, aside, [class*='cookie'], [class*='menu'], [class*='nav']";
    // WICHTIG: <body>/<html> dürfen nie als Skip-Container zählen. Viele Themes (z. B. Divi:
    // "et_fixed_nav", "et_transparent_nav") setzen Klassen mit "nav"/"menu" direkt auf <body> –
    // ein simples closest(skipAncestors) würde dann ALLE Absätze der Seite verwerfen.
    const isSkipped = (node) => node.parentsUntil("body").addBack().filter(skipAncestors).length > 0;

    const boundaries = [];
    const firstH1 = $("h1").first();
    if (
      firstH1.length &&
      headingText(firstH1) &&
      !isSkipped(firstH1) &&
      !isHiddenEverywhere(firstH1)
    ) {
      boundaries.push({
        heading: headingText(firstH1),
        order: orderIndex.get(firstH1.get(0)),
        level: "H1",
      });
    }
    $("h2").each((_, el) => {
      const node = $(el);
      const heading = headingText(node);
      if (!heading) return;
      if (isSkipped(node)) return;
      if (isHiddenEverywhere(node)) return;
      boundaries.push({ heading, order: orderIndex.get(el), level: "H2" });
    });
    $("h3").each((_, el) => {
      const node = $(el);
      const heading = headingText(node);
      if (!heading) return;
      if (isSkipped(node)) return;
      if (isHiddenEverywhere(node)) return;
      boundaries.push({ heading, order: orderIndex.get(el), level: "H3" });
    });

    // H4-H6: oft Template-/Karten-Überschriften (z. B. "Kunden", "Unsere Vision"). Ohne diese Grenzen
    // landet der Text darunter fälschlich im zuvor stehenden Abschnitt (z. B. Platzhaltertext unter
    // einer H5 im Abschnitt "Familienrecht").
    ["h4", "h5", "h6"].forEach((tag) => {
      $(tag).each((_, el) => {
        const node = $(el);
        const heading = headingText(node);
        if (!heading) return;
        if (isSkipped(node)) return;
        if (isHiddenEverywhere(node)) return;
        boundaries.push({ heading, order: orderIndex.get(el), level: tag.toUpperCase() });
      });
    });

    // "Fett statt Überschrift": viele CMS-Freitextblöcke (v. a. Shop-Systeme wie Shopware) werden
    // von Kunden/Redakteuren so gepflegt, dass eine Zeile komplett FETT gesetzt wird, um optisch
    // wie eine Überschrift zu wirken – technisch aber nur <p><strong>...</strong></p> statt eines
    // echten <h2>/<h3>. Ohne diese Erkennung werden solche Textblöcke komplett übersehen (der
    // gesamte Abschnitt landet unsichtbar "irgendwo" im vorherigen oder gar keinem Abschnitt).
    // Bewusst konservativ: nur wenn der GESAMTE Absatztext in genau einem <strong>/<b> steckt
    // (keine Teil-Fettung mitten im Fließtext) und die Zeile kurz genug ist, um plausibel eine
    // Überschrift statt eines fett hervorgehobenen Satzes im Fließtext zu sein.
    $("p").each((_, el) => {
      const node = $(el);
      if (isSkipped(node)) return;
      if (isHiddenEverywhere(node)) return;
      const boldChildren = node.children("strong, b");
      if (boldChildren.length !== 1) return;
      const fullText = node.text().replace(/\s+/g, " ").trim();
      const boldText = boldChildren.first().text().replace(/\s+/g, " ").trim();
      if (!fullText || !boldText || fullText !== boldText) return;
      if (fullText.length < 3 || fullText.length > 90) return;
      boundaries.push({ heading: fullText, order: orderIndex.get(el), level: "H3" });
    });

    boundaries.sort((a, b) => a.order - b.order);

    boundaries.forEach((b, i) => {
      const nextOrder = i + 1 < boundaries.length ? boundaries[i + 1].order : Infinity;
      const parts = [];
      $("p, li").each((_, el) => {
        const node = $(el);
        const elOrder = orderIndex.get(el);
        if (elOrder == null || elOrder <= b.order || elOrder >= nextOrder) return;
        if (isSkipped(node)) return;
        if (isHiddenEverywhere(node)) return;
        // Karten-Wrapper: ein <li>/<p>, das selbst eine Überschrift enthält (z. B. <li><h3>…</h3><p>…</p></li>),
        // ist nur Layout – sein Text würde sonst samt Überschrift im FALSCHEN (vorherigen) Abschnitt
        // landen. Die enthaltenen <p> werden separat gezählt.
        if (node.find("h1,h2,h3,h4,h5,h6").length) return;
        // Eyebrow/Kicker-Zeilen ("Unsere Leistungen" über einer Überschrift) gehören zur FOLGENDEN
        // Überschrift, nicht zum davor stehenden Abschnitt.
        if (/eyebrow|kicker|overline|pretitle|supertitle|sr-only|screen-reader/i.test(node.attr("class") || "")) return;
        const t = node.text().replace(/\s+/g, " ").trim();
        if (t && t.length >= 15) parts.push(t);
      });
      const text = parts.join(" ").trim();
      if (text) sections.push({ heading: b.heading, text: text.slice(0, 1200), level: b.level });
    });
  }
  if (sections.length === 0) {
    // Fallback: gar keine verwertbaren Abschnitte gefunden -> Fließtext aus <main>/<body> nehmen
    const fallbackText = ($("main").text() || $("body").text() || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200);
    if (fallbackText) sections.push({ heading: title || "Haupttext", text: fallbackText });
  }
  // Deckelung: bei sehr Karten-/Grid-lastigen Seiten (viele H3 mit eigenem Text) nicht ausufern lassen.
  if (sections.length > MAX_SECTIONS) sections.length = MAX_SECTIONS;

  // Bilder inkl. Alt-Text (Logos/Icons herausfiltern – erst per Dateiname, dann per echter
  // Bildgröße für alles, was durch den Dateiname-Filter durchrutscht, siehe probeIsTinyImage()).
  const images = [];
  const sizeProbeCandidates = [];
  $("img").each((_, el) => {
    if (images.length + sizeProbeCandidates.length >= MAX_IMAGES * 3) return; // grobe Obergrenze vor dem Größen-Check
    // Lazy-Loading: Ist "src" nur ein data:-Platzhalter, steckt das echte Bild in data-src & Co.
    let src = $(el).attr("src") || "";
    if (!src || /^data:/i.test(src)) {
      src =
        $(el).attr("data-src") ||
        $(el).attr("data-lazy-src") ||
        $(el).attr("data-original") ||
        "";
    }
    if (!src || /^data:/i.test(src)) return;
    if (WIDGET_IMAGE_HOST_PATTERN.test(src)) return;
    if (WIDGET_IMAGE_ALT_PATTERN.test(($(el).attr("alt") || "").trim())) return;
    if (ICON_FILENAME_PATTERN.test(imageFileName(src))) return;
    const wAttr = parseInt($(el).attr("width"), 10);
    const hAttr = parseInt($(el).attr("height"), 10);
    if (wAttr && hAttr && wAttr <= ICON_MAX_SIZE_PX && hAttr <= ICON_MAX_SIZE_PX) return;
    const absSrc = absolutize(pageUrl, src);
    const alt = ($(el).attr("alt") || "").trim();
    const entry = { src: absSrc, alt };
    images.push(entry);
    // Nur Bilder OHNE Alt-Text müssen wir überhaupt per Netzwerk-Probe prüfen – bei vorhandenem
    // Alt-Text ist es fürs Tool ohnehin egal, ob es ein Icon ist oder nicht.
    if (!alt && !(wAttr && hAttr)) sizeProbeCandidates.push(entry);
  });
  if (sizeProbeCandidates.length) {
    const tinyChecks = await Promise.all(
      sizeProbeCandidates.map((entry) => probeIsTinyImage(entry.src))
    );
    const tinySet = new Set();
    tinyChecks.forEach((isTiny, i) => {
      if (isTiny) tinySet.add(sizeProbeCandidates[i]);
    });
    for (let i = images.length - 1; i >= 0; i--) {
      if (tinySet.has(images[i])) images.splice(i, 1);
    }
  }
  if (images.length > MAX_IMAGES) images.length = MAX_IMAGES;

  // Interne Links (für den automatischen 404-Check): gleiche Domain wie die Zielseite, keine
  // mailto:/tel:/javascript:/reinen Anker-Links, keine Duplikate. Wird NICHT nach skipAncestors
  // gefiltert, da auch fehlerhafte Links in Menü/Footer für den Kunden relevant sind.
  const links = [];
  {
    const seen = new Set();
    let pageHost = "";
    try {
      pageHost = new URL(pageUrl).hostname;
    } catch (e) {
      /* ungültige pageUrl -> kein Host-Filter möglich, dann werden keine Links gesammelt */
    }
    if (pageHost) {
      $("a[href]").each((_, el) => {
        if (links.length >= MAX_LINKS_CHECK) return;
        if (isHiddenEverywhere($(el))) return; // Link in unsichtbarem Bereich: für Besucher irrelevant
        const hrefRaw = ($(el).attr("href") || "").trim();
        if (!hrefRaw || /^(mailto:|tel:|javascript:|#)/i.test(hrefRaw)) return;
        const abs = absolutize(pageUrl, hrefRaw);
        let u;
        try {
          u = new URL(abs);
        } catch (e) {
          return;
        }
        if (u.hostname !== pageHost) return;
        u.hash = "";
        const clean = u.href;
        if (seen.has(clean)) return;
        seen.add(clean);
        const text = $(el).text().replace(/\s+/g, " ").trim().slice(0, 80);
        links.push({ url: clean, text: text });
      });
    }
  }

  // Kontaktseite (für den CTA-Button, falls statt einer Telefonnummer dorthin verlinkt werden soll):
  // erster interner Link, dessen Pfad oder Linktext auf "Kontakt" hindeutet.
  let contactUrl = "";
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, "");
    $("a[href]").each((_, el) => {
      if (contactUrl) return;
      const href = ($(el).attr("href") || "").trim();
      if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
      const abs = absolutize(pageUrl, href);
      let u;
      try { u = new URL(abs); } catch (e) { return; }
      if (u.hostname.replace(/^www\./, "") !== host) return;
      const txt = $(el).text().replace(/\s+/g, " ").trim();
      if (/kontakt|contact/i.test(u.pathname) || /^kontakt/i.test(txt)) {
        u.hash = "";
        contactUrl = u.href;
      }
    });
  } catch (e) {
    /* ohne gültige URL kein Vorschlag */
  }

  // Button-/CTA-artige Texte
  const buttons = [];
  $(
    'a.button, a.btn, button, a[class*="btn"], a[class*="button"], a[role="button"]'
  ).each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t && t.length <= 60 && buttons.indexOf(t) === -1) buttons.push(t);
  });

  // Farb-/Schrift-Hinweise aus <style> + inline style=""
  const rawStyleBlock = $("style").text();
  const styleText =
    rawStyleBlock +
    " " +
    $("[style]")
      .map((_, el) => $(el).attr("style"))
      .get()
      .join(" ");
  function isGrayscale(hex) {
    const h = hex.replace("#", "");
    const full =
      h.length === 3
        ? h.split("").map((c) => c + c).join("")
        : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    // gilt als "grau/Text-Farbe" wenn R/G/B sehr nah beieinander liegen
    return Math.max(r, g, b) - Math.min(r, g, b) < 12;
  }
  const bgColorRegex = /background(?:-color)?\s*:\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))\b/gi;

  // 1) Bevorzugt: Hintergrundfarbe direkt auf Button-/CTA-artigen Elementen (Inline-Style).
  const buttonColorCounts = {};
  $(
    'a.button, a.btn, button, a[class*="btn"], a[class*="button"], a[class*="cta"], [class*="cta"], a[role="button"]'
  ).each((_, el) => {
    const style = $(el).attr("style") || "";
    let bm;
    bgColorRegex.lastIndex = 0;
    while ((bm = bgColorRegex.exec(style))) {
      const c = bm[1].toUpperCase();
      if (!isGrayscale(c)) buttonColorCounts[c] = (buttonColorCounts[c] || 0) + 1;
    }
  });

  // 2) Zweitbeste Quelle: CSS-Regeln in <style>, deren Selektor auf Button/CTA hindeutet.
  const ruleRegex = /([^{}]+)\{([^{}]*)\}/g;
  let rm;
  while ((rm = ruleRegex.exec(rawStyleBlock))) {
    const selector = rm[1];
    const body = rm[2];
    if (!/btn|button|cta/i.test(selector)) continue;
    let bm;
    bgColorRegex.lastIndex = 0;
    while ((bm = bgColorRegex.exec(body))) {
      const c = bm[1].toUpperCase();
      if (!isGrayscale(c)) buttonColorCounts[c] = (buttonColorCounts[c] || 0) + 1;
    }
  }

  const sortedButtonColors = Object.keys(buttonColorCounts).sort(
    (a, b) => buttonColorCounts[b] - buttonColorCounts[a]
  );

  // 3) Fallback: häufigste nicht-graue Farbe irgendwo im Quellcode (alte Heuristik).
  const colorCounts = {};
  const colorRegex = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  let m;
  while ((m = colorRegex.exec(styleText))) {
    const c = m[0].toUpperCase();
    colorCounts[c] = (colorCounts[c] || 0) + 1;
  }
  const sortedColors = Object.keys(colorCounts)
    .filter((c) => !isGrayscale(c))
    .sort((a, b) => colorCounts[b] - colorCounts[a]);

  const brandColorGuess = sortedButtonColors[0] || sortedColors[0] || (themeColor || null);

  const fontMatch = styleText.match(/font-family\s*:\s*([^;}]+)/i);
  const fontGuess = fontMatch ? fontMatch[1].replace(/['"]/g, "").trim() : null;

  // Kontaktdaten (grobe Heuristik) + evtl. vorhandenes LocalBusiness-Schema
  // Text MIT Trennzeichen zwischen Elementen: $("body").text() klebt benachbarte Elemente (z. B.
  // <li>Fürth</li><li>0911 …</li>) ohne Leerzeichen zusammen – dann verschmelzen PLZ/Ort, Telefon und
  // E-Mail und werden falsch oder gar nicht erkannt.
  const bodyText = (() => {
    const c = $("body").clone();
    c.find("script,style,noscript").remove();
    c.find("br").replaceWith(" ");
    c.find("*").each((_, e) => {
      $(e).append(" ");
    });
    return c.text().replace(/\s+/g, " ");
  })();
  // Telefon: auch Schreibweisen wie "0911 / 76 14 02" oder "0911-36680800" (Leerzeichen/Schrägstrich/
  // Bindestrich als Trenner); plausible Länge (7-15 Ziffern) wird zusätzlich geprüft.
  // Zeilenweiser Text (jedes Element/jeder <br> = eigene Zeile): für Telefon- und Adress-Erkennung,
  // damit benachbarte Angaben (z. B. Tel. und Fax) nicht zu EINER langen Zahl verschmelzen.
  let textLines = [];
  try {
    const lc = $("body").clone();
    lc.find("script,style,noscript").remove();
    lc.find("br").replaceWith("\n");
    lc.find("p,div,li,address,h1,h2,h3,h4,h5,h6,td,tr,section,footer,span,a").each((_, e) => {
      $(e).append("\n");
    });
    textLines = lc
      .text()
      .split(/\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  } catch (e) {
    textLines = [];
  }
  const PHONE_RE = /(\+49[\s\d/\-()]{6,}\d|0\d{2,5}[\s/\-]*\d[\d\s/\-]{4,}\d)/g;
  const plausiblePhone = (p) => {
    const digits = p.replace(/\D/g, "").length;
    return digits >= 7 && digits <= 15;
  };
  let phoneFound = "";
  for (const line of textLines) {
    const cands = (line.match(PHONE_RE) || []).map((p) => p.trim()).filter(plausiblePhone);
    if (cands.length) {
      phoneFound = cands[0];
      break;
    }
  }
  if (!phoneFound) {
    phoneFound = (bodyText.match(PHONE_RE) || []).map((p) => p.trim()).filter(plausiblePhone)[0] || "";
  }
  const phoneMatch = phoneFound ? [phoneFound] : null;
  const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  let addressMatch = bodyText.match(
    /([A-ZÄÖÜ][a-zäöüß.]+(?:straße|strasse|str\.|weg|platz|allee|ring)\s?\d+[a-zA-Z]?)\s*,?\s*(\d{5})\s+([A-ZÄÖÜ][a-zäöüß-]+)/
  );
  // Fallback für beliebige Straßennamen ("An der Christuskirche 1", "Am Markt 3 a" …): Text MIT
  // Zeilenumbrüchen aufbauen und PLZ+Ort-Zeile suchen; die Zeile davor (mit Hausnummer) ist die Straße.
  if (!addressMatch) {
    try {
      const lines = textLines;
      for (let i = 0; i < lines.length && !addressMatch; i++) {
        const zipCity = lines[i].match(/^(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]{1,40})$/);
        const sameLine = lines[i].match(/^(.{3,50}?\s\d+\s?[a-zA-Z]?)[,\s]+(\d{5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß.\- ]{1,40})$/);
        if (sameLine) {
          addressMatch = [sameLine[0], sameLine[1], sameLine[2], sameLine[3]];
        } else if (zipCity && i > 0) {
          const prev = lines[i - 1];
          if (/\d/.test(prev) && prev.length <= 60 && !/^\+?\d[\d\s/\-()]*$/.test(prev)) {
            addressMatch = [prev + ", " + lines[i], prev, zipCity[1], zipCity[2].trim()];
          }
        }
      }
    } catch (e) {
      /* Fallback ist optional */
    }
  }
  // Öffnungszeiten: NICHT auf sections/skipAncestors beschränkt, da diese Info in der Praxis fast
  // immer im Footer oder einer Kontakt-Box außerhalb der normalen Textabschnitte steht – genau dort,
  // wo der Abschnitts-Extraktor bewusst nicht sucht. Erkennt Tages-/Tagesbereich-Angaben mit
  // Uhrzeit-Bereich, z. B. "Mo. - Fr.: 10:00 - 18:00 Uhr" oder "Sa 10-14 Uhr".
  const DAY_RE = "(?:Mo|Di|Mi|Do|Fr|Sa|So)\\.?";
  const DASH = "[-\\u2013\\u2014]"; // Bindestrich, Halbgeviert- und Geviertstrich ("Mo–Fr")
  // Uhrzeit-Bereich "08:00–16:00" (mit Doppelpunkt, "Uhr" optional) ODER "10-18 Uhr" (ohne Minuten, dann "Uhr" Pflicht)
  const hoursRegex = new RegExp(
    DAY_RE + "(?:\\s*" + DASH + "\\s*" + DAY_RE + ")?\\s*:?\\s*(?:" +
      "\\d{1,2}[:.]\\d{2}\\s*" + DASH + "\\s*\\d{1,2}[:.]\\d{2}(?:\\s*Uhr)?" +
      "|\\d{1,2}(?:[:.]\\d{2})?\\s*" + DASH + "\\s*\\d{1,2}(?:[:.]\\d{2})?\\s*Uhr)",
    "gi"
  );
  // Dubletten (Topbar "Mo–Fr 08:00–16:00" + Footer "Mo–Fr 08:00–16:00 Uhr") zusammenfassen, die
  // ausführlichere Schreibweise gewinnt.
  const hoursByKey = new Map();
  (bodyText.match(hoursRegex) || []).forEach((raw) => {
    const x = raw.trim();
    const key = x.replace(/\s*Uhr$/i, "").replace(/\s+/g, "").toLowerCase();
    if (!hoursByKey.has(key) || hoursByKey.get(key).length < x.length) hoursByKey.set(key, x);
  });
  const hoursMatches = Array.from(hoursByKey.values()).slice(0, 4);
  // Zusätze wie "Samstag auf Anfrage" / "Sonntag geschlossen" mitnehmen
  const hoursExtra = (
    bodyText.match(/(?:Samstag|Sonntag|Sa\.|So\.)\s*(?:auf Anfrage|nach Vereinbarung|geschlossen|Ruhetag)/gi) || []
  ).filter((x, i, arr) => arr.indexOf(x) === i).slice(0, 2);
  if (hoursMatches.length) hoursExtra.forEach((x) => hoursMatches.push(x));

  let existingLocal = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const arr = Array.isArray(data) ? data : [data];
      arr.forEach((obj) => {
        if (obj && /LocalBusiness|Organization/.test(obj["@type"] || "")) {
          existingLocal = obj;
        }
      });
    } catch (e) {
      /* ungültiges JSON-LD ignorieren */
    }
  });

  // Geo-Koordinaten + Beschreibung: nur übernehmen, wenn die Kundenseite selbst bereits ein
  // LocalBusiness/Organization-Schema mit "geo" bzw. "description" hinterlegt hat – wir erfinden
  // hier bewusst keine Koordinaten, sondern lesen nur real vorhandene Werte aus.
  let existingLat = "";
  let existingLng = "";
  if (existingLocal && existingLocal.geo) {
    const geo = Array.isArray(existingLocal.geo) ? existingLocal.geo[0] : existingLocal.geo;
    if (geo) {
      existingLat = geo.latitude != null ? String(geo.latitude) : "";
      existingLng = geo.longitude != null ? String(geo.longitude) : "";
    }
  }
  const existingDescription =
    (existingLocal && typeof existingLocal.description === "string" && existingLocal.description.trim()) || "";

  // Öffnungszeiten: strukturierte Angabe aus vorhandenem JSON-LD hat Vorrang (zuverlässiger als
  // Text-Heuristik), sonst die per Regex im sichtbaren Seitentext gefundenen Zeiten (siehe oben).
  let existingHours = "";
  if (existingLocal && existingLocal.openingHours) {
    existingHours = Array.isArray(existingLocal.openingHours)
      ? existingLocal.openingHours.join(", ")
      : String(existingLocal.openingHours);
  } else if (existingLocal && Array.isArray(existingLocal.openingHoursSpecification)) {
    existingHours = existingLocal.openingHoursSpecification
      .map((spec) => {
        if (!spec) return "";
        const days = Array.isArray(spec.dayOfWeek) ? spec.dayOfWeek.join("/") : spec.dayOfWeek || "";
        const from = spec.opens || "";
        const to = spec.closes || "";
        return [days, from && to ? from + "-" + to : ""].filter(Boolean).join(" ");
      })
      .filter(Boolean)
      .join(", ");
  }
  if (!existingHours && hoursMatches.length) {
    existingHours = hoursMatches.join(", ");
  }

  // Logo (für Local Schema): erstes Bild im Header/Link zur Startseite, dessen Pfad auf ein Logo hindeutet.
  let logoUrl = "";
  $("header img, a[href='/'] img, a[rel='home'] img, img[class*='logo'], img[src*='logo']").each((_, el) => {
    if (logoUrl) return;
    const src = $(el).attr("src") || $(el).attr("data-src") || "";
    if (src && !/^data:/i.test(src) && /logo/i.test(src)) logoUrl = absolutize(pageUrl, src);
  });

  return {
    url: pageUrl,
    logoUrl,
    contactUrl,
    title,
    metaDesc,
    themeColor,
    h1s,
    sections,
    images,
    links,
    buttons,
    brandColorGuess,
    fontGuess,
    phone: phoneMatch ? phoneMatch[0].trim() : (existingLocal && existingLocal.telephone) || "",
    email: emailMatch ? emailMatch[0] : "",
    street: addressMatch ? addressMatch[1].trim() : "",
    zip: addressMatch ? addressMatch[2] : "",
    city: addressMatch ? addressMatch[3] : "",
    existingLocal,
    existingLat,
    existingLng,
    existingHours,
    existingDescription,
  };
}

/* =========================================================================
   3. Claude-Aufruf
   ========================================================================= */

async function callClaude(prompt) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY ist auf dem Server nicht gesetzt (Render → Environment)."
    );
  }
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const msg = (data && data.error && data.error.message) || resp.status;
    throw new Error("Claude API Fehler: " + msg);
  }
  if (data.stop_reason === "max_tokens") {
    console.warn("Claude-Antwort wurde wegen max_tokens abgeschnitten.");
  }
  return (data.content || []).map((b) => b.text || "").join("");
}

// Repariert die häufigsten JSON-Fehler der KI: (1) nicht maskierte Anführungszeichen mitten in einem
// Text ("Wir bieten "Komplettbäder" an"), (2) echte Zeilenumbrüche/Tabs innerhalb von Strings,
// (3) hängende Kommas vor } oder ]. Ein " innerhalb eines Strings gilt nur dann als Textende, wenn
// danach (ohne Leerraum) , } ] : oder das Textende folgt – sonst wird es maskiert.
function repairJson(src) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      out += ch + (src[i + 1] || "");
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      const next = src[j];
      if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
        inStr = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    if (ch === "\n") { out += "\\n"; continue; }
    if (ch === "\r") { continue; }
    if (ch === "\t") { out += "\\t"; continue; }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function extractJson(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("KI-Antwort enthielt kein auswertbares JSON.");
  }
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch (e1) {
    try {
      return JSON.parse(repairJson(body));
    } catch (e2) {
      e1.message = "KI-Antwort war kein gültiges JSON: " + e1.message;
      throw e1;
    }
  }
}

/* =========================================================================
   4. Prompt-Aufbau
   ========================================================================= */

const MIN_FAQ_COUNT = 5;

// Plant die FAQ-Menge: "total" ist die GESAMT-Zielanzahl (vorhandene + neue), mindestens 5.
// faqCount === 0 = "nur vorhandene Fragen prüfen, nichts Neues erzeugen" (nur sinnvoll, wenn schon
// FAQs eingetragen sind – ohne vorhandene FAQs gilt trotzdem der Mindestwert).
// keepOnly = vorhandene FAQs nur auf Rechtschreibung prüfen, nichts ergänzen (entweder ausdrücklich
// gewünscht oder weil bereits genug FAQs vorhanden sind).
function faqPlan(input) {
  const existing = Array.isArray(input.existingFaqItems) ? input.existingFaqItems : [];
  const requested = Number.isFinite(input.faqCount) ? input.faqCount : MIN_FAQ_COUNT;
  const checkOnly = requested === 0 && existing.length > 0;
  const total = Math.max(MIN_FAQ_COUNT, requested);
  const keepOnly = existing.length > 0 && (checkOnly || existing.length >= total);
  return { existing, total, keepOnly, addCount: keepOnly ? 0 : Math.max(0, total - existing.length) };
}

function buildPrompt(input, mainData, subpages) {
  const { keywords, clientName, contactEmail, existingFaqItems } = input;
  const plan = faqPlan(input);
  const hasExistingFaq = plan.existing.length > 0;
  const wantedFaqCount = plan.total;

  const sectionsForPrompt = mainData.sections.map((s, i) => ({
    index: i,
    level: s.level || "H2",
    heading: s.heading,
    words: (s.text || "").split(/\s+/).filter(Boolean).length,
    text: s.text,
  }));
  const imagesForPrompt = mainData.images.map((img, i) => ({
    index: i,
    currentAlt: img.alt,
  }));
  const subpagesForPrompt = subpages
    .filter((p) => p.url)
    .map((p) => ({
      url: p.url,
      name: p.name,
      h1Count: (p.h1s || []).length,
      h1s: p.h1s || [],
      metaTitle: p.title,
      metaDesc: p.metaDesc,
      imagesTotal: p.imagesTotal || 0,
      imagesMissingAlt: (p.imagesMissingAltList || []).map((src, i) => ({ index: i, src })),
    }));

  return `Du bist SEO-Texter/in bei der Agentur SELLWERK und bereitest eine DIY-SEO-Optimierungsanleitung für einen Kunden vor.

KONTEXT
- Kunde: ${clientName || "unbekannt"}
- Ziel-Keywords: ${keywords || "keine angegeben"}
- Ziel-URL: ${mainData.url}

AKTUELL AUF DER SEITE GEFUNDEN ("Vorher", NICHT verändern – nur als Kontext nutzen)
Meta-Titel: ${JSON.stringify(mainData.title)}
Meta-Beschreibung: ${JSON.stringify(mainData.metaDesc)}
H1-Überschrift(en): ${JSON.stringify(mainData.h1s)}
Abschnitte (Feld "level" zeigt die Überschriften-Ebene H1-Intro/H2/H3; H3 sind z. B. einzelne Karten in einem Grid – behandle jeden Abschnitt gleichwertig): ${JSON.stringify(sectionsForPrompt)}
Bilder (nur aktueller Alt-Text, Reihenfolge = Index): ${JSON.stringify(imagesForPrompt)}
Button-/Link-Texte auf der Seite: ${JSON.stringify(mainData.buttons)}
Erkannte Hauptfarbe der Seite (Hex, falls gefunden): ${mainData.brandColorGuess || "keine erkannt"}
Erkannte Schriftart der Seite (falls gefunden): ${mainData.fontGuess || "keine erkannt"}
Kontakt-Hinweise (automatisch gefunden, ungeprüft): Telefon=${mainData.phone || "-"}, Straße=${mainData.street || "-"}, PLZ=${mainData.zip || "-"}, Ort=${mainData.city || "-"}, Öffnungszeiten=${mainData.existingHours || "-"}
Geprüfte Unterseiten (nur die mit URL, Reihenfolge relevant): ${JSON.stringify(subpagesForPrompt)}
Bereits vom Kollegen/von der Kollegin eingetragene FAQs (falls vorhanden): ${hasExistingFaq ? JSON.stringify(existingFaqItems) : "keine – noch nicht befüllt"}

AUFGABE
Erzeuge ausschließlich die folgenden NEUEN/OPTIMIERTEN Inhalte (keine "Vorher"-Werte wiederholen) als
EIN einziges valides JSON-Objekt, exakt in diesem Schema (fehlende Infos als leerer String "" bzw. leeres Array):

{
  "metaTitleNachher": string (max. 60 Zeichen, enthält die wichtigsten Keywords),
  "metaDescNachher": string (max. 155 Zeichen, Call-to-Action-artig, enthält Keywords),
  "metaReason": string (IMMER befüllen: kurze, für Laien verständliche Begründung, was am Meta-Titel/an der Meta-Beschreibung verbessert wurde bzw. worauf beim Einfügen zu achten ist, z. B. Zeichenlänge, automatisch angehängte CMS-Suffixe),
  "h1Assessment": {
    "optimized": boolean (true = die vorhandene H1 ist bereits gut auf die Ziel-Keywords optimiert, keine Änderung nötig),
    "h1Nachher": string (nur befüllen wenn optimized:false – dein verbesserter H1-Vorschlag; sonst leerer String ""),
    "reason": string (IMMER befüllen: kurze, für Laien verständliche Begründung – entweder wieso die H1 schon gut ist, oder was am neuen Vorschlag besser ist)
  },
  "sectionsNachher": [ { "index": number, "changed": boolean (true = Überschrift und/oder Text wurden inhaltlich verbessert), "nUeb": string, "nText": string, "note": string (IMMER befüllen: bei changed:true kurz was verbessert wurde, bei changed:false kurz wieso keine Änderung nötig war) } ... eines pro obigem Abschnitt, gleicher Index ],
  "newSections": [ { "after": number (Index des bestehenden Abschnitts, NACH dem der neue Abschnitt stehen soll; -1 = ganz am Anfang), "neuUeb": string (H2-Überschrift mit passendem Ziel-Keyword), "neuText": string (ca. 60-120 Wörter, nur auf Basis der tatsächlichen Seiteninhalte, KEINE erfundenen Fakten), "reason": string (welche konkrete Lücke dieser Abschnitt schließt) } ... 0 bis 3 Stück, siehe WICHTIG-Hinweis zur Lückenanalyse; leeres Array [], wenn keine echte Lücke erkennbar ist ],
  "faqHeadline": string,
  "faqIntro": string,
  "faqItems": [ { "frage": string, "antwort": string } ... ${
    plan.keepOnly
      ? `GENAU ${existingFaqItems.length} Stück, in EXAKT derselben Reihenfolge wie die oben gelisteten "Bereits vom Kollegen/von der Kollegin eingetragene FAQs" – NICHTS Neues erfinden oder ergänzen, siehe WICHTIG-Hinweis unten`
      : hasExistingFaq
      ? `GENAU ${plan.total} Stück: zuerst die ${existingFaqItems.length} oben gelisteten vorhandenen FAQs in derselben Reihenfolge (inhaltlich unverändert, nur Rechtschreibung korrigiert), danach ${plan.addCount} NEUE, an den Ziel-Keywords orientierte FAQs, die sich thematisch nicht mit den vorhandenen überschneiden`
      : `genau ${wantedFaqCount} Stück, an Keywords orientiert`
  } ],
  "cta": {
    "headline": string, "subtext": string, "buttonText": string,
    "color": string (Hex-Code; nutze die erkannte Hauptfarbe der Seite falls vorhanden, sonst einen zur Branche passenden Farbton),
    "font": string (nutze die erkannte Schriftart der Seite falls vorhanden, sonst "" leer lassen),
    "design": "klassisch" | "banner" | "karte" | "zweispaltig" (wähle das Design, das optisch am besten zur Seite passt; dezent, modern, ohne Bilder)
  },
  "altNachher": [ { "index": number, "nAlt": string } ... eines pro obigem Bild, gleicher Index, SEO-optimierter Alt-Text mit Ortsbezug/Leistung falls erkennbar ],
  "buttonItems": [ { "vBtn": string (Text 1:1 aus der obigen Button-Liste), "nBtn": string (konkreterer, SEO-freundlicherer Vorschlag) } ... bis zu 3 Stück, nur wenn Verbesserung sinnvoll ist ],
  "linkItems": [ { "word": string (Wort/Textstelle aus den obigen Abschnittstexten), "target": string (MUSS exakt eine der URLs aus der Liste "Geprüfte Unterseiten" oben sein – NIEMALS einen Pfad selbst ausdenken/schätzen, auch nicht wenn er plausibel klingt), "context": string (kurzer Hinweis, in welchem Abschnitt) } ... 0 bis 3 Stück, NUR wenn "Geprüfte Unterseiten" mindestens eine passende URL enthält; ist die Liste leer oder passt keine Unterseite thematisch, MUSS "linkItems" ein leeres Array [] sein ],
  "spellingItems": [ { "context": string (kurzer Satzausschnitt aus den obigen Texten, OHNE das falsche Wort selbst zu verändern), "wrong": string (das fehlerhafte Wort/die fehlerhafte Stelle exakt wie im Text), "correct": string (Korrektur), "page": string (NUR befüllen, wenn der Fehler auf einer der "Geprüften Unterseiten" gefunden wurde – dann den "name" oder die "url" dieser Unterseite eintragen; bei einem Fehler auf der Zielseite selbst leerer String "") } ... JEDER tatsächlich gefundene Rechtschreib-/Grammatikfehler auf der Zielseite UND auf den geprüften Unterseiten, leeres Array NUR wenn nach echter Prüfung wirklich keiner gefunden wurde ],
  "local": { "areaServed": string, "description": string (kurze, prägnante 1-2-Satz-Unternehmensbeschreibung für das Local-Schema, basierend auf den tatsächlichen Seiteninhalten, KEINE erfundenen Fakten) } oder null (nur falls aus dem Text/Branche plausibel ableitbar),
  "pagesNachher": [ { "url": string, "h1Optimized": boolean (NUR relevant/befüllen wenn h1Count der Unterseite genau 1 ist: true = die vorhandene H1 ist bereits gut auf die Ziel-Keywords optimiert), "h1Nachher": string (befüllen wenn h1Count != 1 ein sinnvoller H1-Vorschlag anhand von Meta-Titel/-Beschreibung möglich ist, ODER wenn h1Count == 1 und h1Optimized:false dein verbesserter Vorschlag; sonst leerer String ""), "h1Reason": string (NUR befüllen wenn h1Count == 1: kurze, für Laien verständliche Begründung wieso die H1 schon gut ist bzw. was am Vorschlag besser wäre; bei h1Count != 1 leerer String ""), "metaTitleNachher": string, "metaDescNachher": string, "altSuggestions": [ { "index": number (gleicher Index wie im Feld "imagesMissingAlt" dieser Unterseite), "nAlt": string (SEO-optimierter Alt-Text-Vorschlag; leite Hinweise nur aus dem Dateinamen in "src", dem Seitennamen/-titel und den Ziel-Keywords ab, erfinde KEINE Bildinhalte, die sich daraus nicht ableiten lassen – im Zweifel allgemein bleiben, z. B. nur Firmen-/Personenname + Ort + Leistung) } ... ein Eintrag pro Bild aus "imagesMissingAlt" dieser Unterseite, leeres Array falls "imagesMissingAlt" leer ist ] } ... eines pro Eintrag aus "Geprüfte Unterseiten" ]
}

WICHTIG
- Gib ausschließlich das JSON-Objekt zurück, keinen Fließtext davor oder danach, keine Markdown-Codeblöcke.
- Halte dich strikt an das Schema und die Feldnamen.
- Schreibe auf Deutsch, professionell, aber verständlich für Laien (der Kunde ist kein SEO-Experte).
- Erfinde keine Fakten (Adressen, Preise, Auszeichnungen) – bei Unsicherheit leer lassen.
- Prüfe die H1-Überschrift aktiv: passt sie zu den Ziel-Keywords, ist sie eindeutig und nicht zu generisch? Nur wenn sie das bereits erfüllt, "optimized": true setzen.
- Prüfe für JEDEN Abschnitt aktiv, ob Überschrift UND Text bereits gut auf die Ziel-Keywords optimiert sind. Verbessere aktiv, wenn Keywords fehlen, die Formulierung zu generisch/unspezifisch ist oder sich die Lesbarkeit verbessern lässt.
- Kopiere niemals eine Überschrift oder einen Text kommentarlos 1:1 vom Vorher-Wert in den Nachher-Wert. Ist wirklich keine Verbesserung nötig, setze "changed": false, übernimm nUeb/nText identisch zum Vorher-Wert UND erkläre im Feld "note" kurz und konkret, wieso die Stelle bereits gut optimiert ist – niemals "note" leer lassen.
- Prüfe für "spellingItems" AKTIV und gründlich auf echte Rechtschreib- und Grammatikfehler: Lies dafür Meta-Titel, Meta-Beschreibung, H1-Überschrift(en) sowie ALLE Abschnitts-Überschriften und -Texte aus dem Abschnitt "AKTUELL AUF DER SEITE GEFUNDEN" bewusst noch einmal komplett Wort für Wort durch (Tippfehler, falsche Groß-/Kleinschreibung, Zeichensetzung, Grammatik, doppelte Wörter, fehlende/falsche Wortendungen). Prüfe GENAUSO gründlich auch die H1-Überschrift(en), den Meta-Titel und die Meta-Beschreibung JEDER einzelnen Unterseite aus "Geprüfte Unterseiten" auf dieselben Fehlerarten. Trage JEDEN tatsächlich gefundenen Fehler als eigenen Eintrag ein (bei Fehlern auf einer Unterseite das Feld "page" mit deren Name/URL befüllen) – gib dich nicht vorschnell mit einem leeren Array zufrieden. Erfinde aber keine Fehler, die im Text nicht wirklich vorhanden sind.
- Prüfe für JEDE Unterseite aus "Geprüfte Unterseiten" mit h1Count == 1 AKTIV, ob die vorhandene H1 (aus "h1s") bereits gut auf die Ziel-Keywords optimiert ist – genau wie bei der Haupt-H1 der Zielseite. Setze "h1Optimized" entsprechend, begründe IMMER in "h1Reason" und mache bei h1Optimized:false einen konkreten Verbesserungsvorschlag in "h1Nachher". Erfinde dabei keine Seiteninhalte, die du nicht kennst – bewerte nur anhand von H1-Text, Meta-Titel, Meta-Beschreibung und den Ziel-Keywords.
- Für JEDES Bild in "imagesMissingAlt" einer Unterseite erzeuge in "altSuggestions" einen SEO-optimierten Alt-Text-Vorschlag (Firmenname/Personenname + Leistung/Ortsbezug, falls aus Seitenname, Meta-Titel oder Dateiname erkennbar) – auch hier gilt: keine erfundenen Bildinhalte, im Zweifel lieber allgemein bleiben statt Details zu erfinden.
- Lückenanalyse für neue Abschnitte ("newSections"): Prüfe die Seite SYSTEMATISCH auf Stellen, an denen ein zusätzlicher Abschnitt mit eigener H2 sinnvoll ist: (a) Ziel-Keywords, die in KEINEM Abschnitt vorkommen oder nur in einem einzigen; (b) lange Textstrecken (Feld "words" über ca. 200) ohne Zwischenüberschrift; (c) Leistungen/Themen, die nur als Stichwort oder Link erwähnt werden, ohne eigenen erklärenden Text; (d) typische Kundenfragen/Themen der Branche, die komplett fehlen, aber aus den vorhandenen Inhalten sauber ableitbar sind. Setze jeden neuen Abschnitt dorthin, wo er thematisch passt (Feld "after" = Index des vorangehenden Abschnitts) – nicht pauschal ans Ende. Schlage nur echte Lücken vor, lieber 0-1 gute als 3 beliebige. Enthält ein bestehender Abschnitt erkennbar Platzhaltertext (z. B. Lorem ipsum), erfinde dafür keinen Ersatz-Fakt, sondern weise im Feld "note" des Abschnitts darauf hin, dass der Text ein Platzhalter ist und durch echten Inhalt ersetzt werden muss.
- FAQs: ${
    plan.keepOnly && hasExistingFaq
      ? `Es sind bereits ${existingFaqItems.length} FAQ(s) vorhanden (siehe oben). Erfinde UNTER GAR KEINEN UMSTÄNDEN zusätzliche oder andere Fragen dazu und lösche/ersetze auch keine. Gib in "faqItems" GENAU diese ${existingFaqItems.length} Frage(n) in derselben Reihenfolge zurück, mit "frage"/"antwort" jeweils 1:1 übernommen – korrigiere darin AUSSCHLIESSLICH echte Rechtschreib-/Grammatikfehler, inhaltlich bleibt alles unverändert.`
      : hasExistingFaq
      ? `Es sind bereits ${existingFaqItems.length} FAQ(s) vorhanden, Ziel sind insgesamt ${plan.total}. Gib in "faqItems" zuerst diese ${existingFaqItems.length} vorhandenen Frage(n) in derselben Reihenfolge zurück ("frage"/"antwort" 1:1, nur echte Rechtschreib-/Grammatikfehler korrigieren, inhaltlich nichts ändern) und ergänze danach genau ${plan.addCount} NEUE FAQs, die thematisch nicht mit den vorhandenen doppelt sind.`
      : `Es sind noch keine FAQs vorhanden. Erzeuge genau ${wantedFaqCount} neue, an den Ziel-Keywords orientierte FAQs (nie weniger als ${MIN_FAQ_COUNT}).`
  }
- Interne Verlinkung ("linkItems"): Verlinke NIEMALS auf eine Unterseite, die nicht wortwörtlich mit ihrer URL in der Liste "Geprüfte Unterseiten" steht – auch kein naheliegend klingender Pfad wie "/leistungen/xyz", den du nur vermutest. Ist die Liste "Geprüfte Unterseiten" leer, gib "linkItems": [] zurück, auch wenn sich inhaltlich eine Verlinkung anbieten würde.
- Rechtschreibprüfung: "Alles ok, keine Fehler gefunden" ist eine Aussage, die du dir erst verdienen musst – lies jeden Text-, Meta- und Überschriften-Wert aus "AKTUELL AUF DER SEITE GEFUNDEN" UND aus "Geprüfte Unterseiten" wirklich Wort für Wort, nicht nur überfliegend. Sei besonders aufmerksam bei: Kommasetzung vor "und"/"oder" bei Aufzählungen, Getrennt-/Zusammenschreibung zusammengesetzter Substantive, Groß-/Kleinschreibung nach Doppelpunkt, falscher Artikel/Kasus, fehlendem Leerzeichen nach Satzzeichen, doppelten Leerzeichen oder Wörtern. Ein leeres "spellingItems"-Array ist nur zulässig, wenn du diese Prüfung tatsächlich Wort für Wort durchgeführt hast und wirklich nichts gefunden hast – nicht als Standardantwort.`;
}

/* =========================================================================
   5. Zusammenführen zu applyImportedData()-kompatiblem JSON
   ========================================================================= */

function pickAiSectionByIndex(list, index) {
  return (list || []).find((x) => x && x.index === index) || {};
}

function mergeResult(ai, mainData, subpages, input) {
  const { url, keywords, clientName, contactEmail, existingFaqItems } = input;

  // Sicherheitsnetz gegen die "10 statt 5 FAQs"-Dopplung: hält sich die KI NICHT an die
  // Prompt-Anweisung (gleiche Anzahl/Reihenfolge bei bereits vorhandenen FAQs), greifen wir hier
  // hart durch, statt uns auf den Prompt allein zu verlassen – lieber die Original-FAQs 1:1
  // unverändert lassen als versehentlich zusätzliche/andere FAQs durchzulassen.
  const plan = faqPlan(input);
  const aiFaq = (Array.isArray(ai.faqItems) ? ai.faqItems : []).filter((f) => f && (f.frage || f.antwort));
  let resolvedFaqItems;
  if (plan.existing.length > 0 && plan.keepOnly) {
    // Nur Rechtschreibkorrektur: KI-Ergebnis nur akzeptieren, wenn die Anzahl exakt passt.
    resolvedFaqItems =
      aiFaq.length === plan.existing.length
        ? aiFaq.map((f, i) => ({
            frage: f.frage || plan.existing[i].frage || "",
            antwort: f.antwort || plan.existing[i].antwort || "",
          }))
        : plan.existing;
  } else if (plan.existing.length > 0) {
    // Vorhandene FAQs bleiben an den ersten Stellen (ggf. rechtschreibkorrigiert), danach die neuen.
    const base = plan.existing.map((f, i) => {
      const a = aiFaq[i];
      return {
        frage: (a && a.frage) || f.frage || "",
        antwort: (a && a.antwort) || f.antwort || "",
      };
    });
    const extras = aiFaq.slice(plan.existing.length).filter((f) => f.frage && f.antwort);
    resolvedFaqItems = base.concat(extras).slice(0, Math.max(plan.total, plan.existing.length));
  } else {
    resolvedFaqItems = aiFaq.slice(0, plan.total);
  }

  const sections = mainData.sections.map((s, i) => {
    const aiS = pickAiSectionByIndex(ai.sectionsNachher, i);
    return {
      type: "bestehend",
      name: s.heading,
      htag: s.level || "H2",
      vUeb: s.heading,
      nUeb: aiS.nUeb || s.heading,
      vText: s.text,
      nText: aiS.nText || s.text,
      changed: aiS.changed !== false,
      note: aiS.note || "",
      includeAlt: false,
      vAlt: "",
      nAlt: "",
    };
  });

  const h1Assessment = ai.h1Assessment || {};
  const h1 = {
    vorher: (mainData.h1s || []).join(", "),
    optimized: h1Assessment.optimized !== false,
    nachher: h1Assessment.h1Nachher || "",
    reason: h1Assessment.reason || "",
  };
  const metaReason = ai.metaReason || "";
  // Neue Abschnitte (Lückenanalyse): jeder wird NACH dem von der KI genannten bestehenden Abschnitt
  // eingefügt (nicht pauschal am Ende). Abwärtskompatibel zum alten Einzelfeld "newSection".
  {
    const existingCount = sections.length;
    const heads = sections.map((x) => x.name);
    let proposals = Array.isArray(ai.newSections) ? ai.newSections : [];
    if (!proposals.length && ai.newSection && (ai.newSection.neuUeb || ai.newSection.neuText)) {
      proposals = [{ after: existingCount - 1, neuUeb: ai.newSection.neuUeb, neuText: ai.newSection.neuText, platz: ai.newSection.platz }];
    }
    proposals = proposals.filter((p) => p && (p.neuUeb || p.neuText)).slice(0, 3);
    const placed = proposals.map((p) => {
      let after = Number.isInteger(p.after) ? p.after : existingCount - 1;
      if (after < -1 || after >= existingCount) after = existingCount - 1;
      return { p, after };
    });
    // von hinten einfügen, damit die Indizes der noch folgenden Einfügungen stimmen
    placed.sort((a, b) => b.after - a.after);
    placed.forEach(({ p, after }) => {
      const platz =
        p.platz ||
        (after < 0
          ? "ganz oben, vor dem ersten Abschnitt"
          : "direkt nach dem Abschnitt „" + (heads[after] || "") + "“");
      sections.splice(after + 1, 0, {
        type: "neu",
        name: p.neuUeb || "Neuer Abschnitt",
        htag: "H2",
        neuUeb: p.neuUeb || "",
        neuText: p.neuText || "",
        platz: platz,
        note: p.reason || "",
      });
    });
  }

  const altItems = mainData.images.map((img, i) => {
    const aiAlt = (ai.altNachher || []).find((x) => x && x.index === i) || {};
    return { vAlt: img.alt, nAlt: aiAlt.nAlt || "", imgUrl: img.src };
  });

  const cta = ai.cta || {};
  const validDesigns = ["klassisch", "banner", "karte", "zweispaltig"];

  const pagesByUrl = {};
  subpages.forEach((p) => {
    if (p.url) pagesByUrl[p.url] = p;
  });
  const pages = subpages.map((p) => {
    if (!p.url) {
      // keine URL angegeben -> Punkt 12: manuell, unverändert zurückgeben
      return {
        name: p.name || "",
        url: "",
        h1status: "ok",
        vH1: "",
        nH1: "",
        h1Reason: "",
        metaTitleV: "",
        metaTitleN: "",
        metaDescV: "",
        metaDescN: "",
        altStatus: "ok",
        altItems: [],
        altTotal: 0,
      };
    }
    if (p.error) {
      return {
        name: p.name || p.url,
        url: p.url,
        h1status: "ok",
        vH1: "",
        nH1: "",
        h1Reason: "",
        metaTitleV: "Fehler beim Abrufen: " + p.error,
        metaTitleN: "",
        metaDescV: "",
        metaDescN: "",
        altStatus: "ok",
        altItems: [],
        altTotal: 0,
      };
    }
    const h1Count = (p.h1s || []).length;
    const aiPage = (ai.pagesNachher || []).find((x) => x && x.url === p.url) || {};
    // H1-Befund: "fehlt"/"mehrere" sind harte Fehler (rein aus der Anzahl ermittelt).
    // Bei genau einer H1 übernehmen wir zusätzlich die inhaltliche KI-Bewertung (wie bei der
    // Haupt-H1): "ok" wenn bereits gut optimiert, sonst "verbesserung" mit Vorschlag+Begründung.
    let h1status;
    if (h1Count === 0) h1status = "fehlt";
    else if (h1Count > 1) h1status = "mehrere";
    else h1status = aiPage.h1Optimized === false ? "verbesserung" : "ok";

    const altTotal = p.imagesTotal || 0;
    const missingAltSrcs = p.imagesMissingAltList || [];
    const altSuggestions = aiPage.altSuggestions || [];
    const altItems = missingAltSrcs.map((src, i) => ({
      imgUrl: src,
      nAlt: (altSuggestions.find((a) => a && a.index === i) || {}).nAlt || "",
    }));
    const altStatus = altItems.length > 0 ? "fehlt" : "ok";

    return {
      name: p.name || p.title || p.url,
      url: p.url,
      h1status,
      vH1: (p.h1s || []).join(", "),
      nH1: aiPage.h1Nachher || "",
      h1Reason: aiPage.h1Reason || "",
      metaTitleV: p.title || "",
      metaTitleN: aiPage.metaTitleNachher || "",
      metaDescV: p.metaDesc || "",
      metaDescN: aiPage.metaDescNachher || "",
      altStatus,
      altItems,
      altTotal,
    };
  });

  const hasLocalHints = !!(
    mainData.phone ||
    mainData.street ||
    mainData.existingLat ||
    mainData.existingHours ||
    (ai.local && (ai.local.areaServed || ai.local.description))
  );

  return {
    clientName: clientName || "",
    contactEmail: contactEmail || "",
    pageUrl: url,
    keywords: keywords || "",

    metaTitleVorher: mainData.title,
    metaTitleNachher: ai.metaTitleNachher || "",
    metaDescVorher: mainData.metaDesc,
    metaDescNachher: ai.metaDescNachher || "",
    metaReason: metaReason,

    h1Vorher: h1.vorher,
    h1Optimized: h1.optimized,
    h1Nachher: h1.nachher,
    h1Reason: h1.reason,

    sections: sections,

    faqHeadline: ai.faqHeadline || "Häufig gestellte Fragen",
    faqIntro: ai.faqIntro || "",
    faqPlatzierung: "als eigene Zeile über Ihrem Footer",
    // faqSchema bewusst NICHT gesetzt: das Häkchen "FAQ-Schema automatisch erzeugen" bleibt
    // client-seitig gesteuert (Standard hängt u. a. davon ab, ob Duda als CMS gewählt ist) und
    // soll durch eine Analyse nicht zurückgesetzt werden.
    faqItems: resolvedFaqItems,

    ctaHeadline: cta.headline || "",
    ctaSubtext: cta.subtext || "",
    ctaButtonText: cta.buttonText || "",
    ctaPhone: mainData.phone || "",
    ctaLinkUrl: mainData.contactUrl || "",
    ctaColor: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(cta.color || "")
      ? cta.color
      : mainData.brandColorGuess || "#ff4040",
    ctaFont: cta.font || mainData.fontGuess || "",
    ctaDesign: validDesigns.indexOf(cta.design) !== -1 ? cta.design : "klassisch",

    altItems: altItems,
    buttonItems: ai.buttonItems || [],
    // Sicherheitsnetz gegen erfundene interne Links: nur durchlassen, was WORTWÖRTLICH auf eine der
    // tatsächlich geprüften Unterseiten-URLs zeigt – alles andere (auch nur leicht abweichende oder
    // "plausibel klingende" Pfade) wird verworfen, statt dem Kunden einen Link auf eine nicht
    // existierende Seite vorzuschlagen.
    linkItems: (() => {
      const knownUrls = new Set((subpages || []).filter((p) => p && p.url).map((p) => p.url));
      // Zusätzlich: das zu verlinkende Wort/die Textstelle muss WIRKLICH in den Abschnittstexten der
      // Seite stehen – sonst ist die Anweisung für den Kunden nicht umsetzbar ("Falls im Text erwähnt…").
      const haystack = (mainData.sections || [])
        .map((x) => (x.heading || "") + " " + (x.text || ""))
        .join(" ")
        .toLowerCase();
      return (Array.isArray(ai.linkItems) ? ai.linkItems : []).filter(
        (l) =>
          l &&
          l.target &&
          knownUrls.has(l.target) &&
          l.word &&
          haystack.includes(String(l.word).toLowerCase().trim())
      );
    })(),
    // brokenLinks wird NICHT von der KI erzeugt, sondern deterministisch im /analyze-Handler
    // per echtem HTTP-Check der internen Links befüllt (siehe findBrokenLinks). Hier nur der
    // leere Default, falls mergeResult() isoliert (z. B. in Tests) ohne diesen Schritt läuft.
    brokenLinks: [],
    spellingItems: ai.spellingItems || [],

    localOn: hasLocalHints,
    local: {
      companyName: clientName || "",
      logoUrl: mainData.logoUrl || "",
      phone: mainData.phone || "",
      street: mainData.street || "",
      zip: mainData.zip || "",
      city: mainData.city || "",
      country: "DE",
      areaServed: (ai.local && ai.local.areaServed) || "",
      // Deterministisch auf der Seite gefundene Öffnungszeiten (JSON-LD oder Text-Heuristik) haben
      // Vorrang vor der KI-Angabe – die KI sieht die Öffnungszeiten oft gar nicht, weil sie meist im
      // Footer/einer Kontakt-Box außerhalb der normal ausgelesenen Textabschnitte stehen.
      // Öffnungszeiten NUR aus dem, was wirklich auf der Seite steht – nie von der KI geschätzt.
      hours: mainData.existingHours || "",
      description: mainData.existingDescription || (ai.local && ai.local.description) || "",
      lat: mainData.existingLat || "",
      lng: mainData.existingLng || "",
    },

    pages: pages,
  };
}

/* =========================================================================
   6. Routen
   ========================================================================= */

app.get("/", (req, res) => {
  res.json({ ok: true, service: "sellwerk-diy-proxy", build: "2026-11-02-report-note" });
});

app.post("/fetch-page", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "url fehlt" });
    const html = await fetchHtml(url);
    res.json({ html });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Einzelnen Abschnittstext per KI erstellen (Button "Neuen Text erstellen" im Editor).
// Bekommt die Überschrift, die Ziel-Keywords und kurze Auszüge der übrigen Abschnitte als
// Stil-/Themenkontext – erzeugt NUR den Text, keine Überschrift, kein Markdown.
function buildTextPrompt(b) {
  const ctx = (Array.isArray(b.context) ? b.context : [])
    .slice(0, 12)
    .map((c) => ({
      heading: String((c && c.heading) || "").slice(0, 120),
      text: String((c && c.text) || "").slice(0, 300),
    }))
    .filter((c) => c.heading || c.text);
  return `Du bist SEO-Texter/in bei der Agentur SELLWERK. Schreibe den Fließtext für EINEN Website-Abschnitt.

KONTEXT
- Kunde: ${String(b.clientName || "unbekannt").slice(0, 120)}
- Ziel-URL: ${String(b.pageUrl || "").slice(0, 300)}
- Ziel-Keywords: ${String(b.keywords || "keine angegeben").slice(0, 300)}
- Überschrift dieses Abschnitts (${String(b.htag || "H2").slice(0, 3)}): ${JSON.stringify(String(b.heading || "").slice(0, 200))}
- Platzierung auf der Seite: ${String(b.platz || "nicht angegeben").slice(0, 200)}
- Bisheriger Text dieses Abschnitts (falls vorhanden, als Grundlage/Orientierung): ${JSON.stringify(String(b.existingText || "").slice(0, 1500))}
- Übrige Abschnitte der Seite (Themen und Tonalität zur Orientierung): ${JSON.stringify(ctx)}

AUFGABE
Schreibe einen Text von ca. 60-120 Wörtern, der zur Überschrift passt, die Ziel-Keywords natürlich einbindet (kein Keyword-Stuffing) und in Ton und Stil zu den übrigen Abschnitten passt. Direkte Ansprache nur, wenn die übrigen Abschnitte sie auch nutzen.

WICHTIG
- Gib AUSSCHLIESSLICH den fertigen Text zurück: keine Überschrift, keine Anführungszeichen drumherum, kein Markdown, keine Einleitung, keine Erklärung.
- Erfinde keine Fakten (Zahlen, Jahre, Auszeichnungen, Preise, Adressen, Referenzen). Bleibe bei Aussagen, die sich aus Überschrift, bisherigem Text und den übrigen Abschnitten ableiten lassen.
- Schreibe auf Deutsch, professionell und verständlich für Laien.`;
}

// Liefert die KI weniger FAQs als verlangt (Standard: mindestens 5), werden die fehlenden in einem
// zweiten, kleinen Aufruf nachgefordert, statt dem Kunden eine zu kurze Liste zu zeigen.
async function fillMissingFaqs(merged, input, mainData, missing) {
  const have = (merged.faqItems || []).map((f) => f.frage).filter(Boolean);
  const prompt = `Du bist SEO-Texter/in bei der Agentur SELLWERK. Erzeuge GENAU ${missing} weitere FAQ(s) (Frage + Antwort) für die Website eines Kunden.

KONTEXT
- Kunde: ${input.clientName || "unbekannt"}
- Ziel-URL: ${mainData.url}
- Ziel-Keywords: ${input.keywords || "keine angegeben"}
- Themen/Abschnitte der Seite: ${JSON.stringify((mainData.sections || []).map((x) => x.heading).slice(0, 15))}
- Bereits vorhandene Fragen (NICHT wiederholen, thematisch nicht doppeln): ${JSON.stringify(have)}

WICHTIG
- Fragen so formulieren, wie echte Kunden suchen; an den Ziel-Keywords orientiert, bei lokalem Bezug mit Ort.
- Antworten 2-4 Sätze, sachlich, KEINE erfundenen Fakten (Preise, Zahlen, Auszeichnungen, Fristen).
- Gib ausschließlich ein JSON-Objekt zurück: {"faqItems":[{"frage":"...","antwort":"..."}]}, ohne Text davor/danach und ohne Markdown.`;
  const raw = await callClaude(prompt);
  const extra = (extractJson(raw).faqItems || []).filter((f) => f && f.frage && f.antwort);
  merged.faqItems = (merged.faqItems || []).concat(extra).slice(0, Math.max(input.faqTotal || 0, (merged.faqItems || []).length));
}

app.post("/generate-text", async (req, res) => {
  try {
    const body = req.body || {};
    if (!String(body.heading || "").trim()) {
      return res.status(400).json({ error: "Bitte zuerst eine Überschrift/einen Abschnittsnamen eintragen." });
    }
    const raw = await callClaude(buildTextPrompt(body));
    const text = String(raw || "")
      .replace(/^```[a-z]*\s*|```\s*$/gi, "")
      .replace(/^["„“]+|["“”]+$/g, "")
      .trim();
    if (!text) throw new Error("Die KI hat keinen Text geliefert.");
    res.json({ text });
  } catch (e) {
    console.error("Fehler bei /generate-text:", e);
    res.status(500).json({ error: e.message });
  }
});


function buildReportNotePrompt(c) {
  const hint = String(c.hint || "").trim();
  const existing = String(c.existing || "").trim();
  return `Du bist SEO-Berater bei der Agentur SELLWERK und schreibst für einen Kunden-Report (Google Search Console) den Abschnitt "Einordnung & Anmerkungen des SEO-Teams". Er steht direkt unter dem Diagramm "Entwicklung pro Monat".

REGELN:
- Deutsch, Sie-Form, sachlich, freundlich, für Laien verständlich. 2 bis 3 kurze Absätze (zusammen max. ca. 170 Wörter). Kein Markdown, keine Listen, keine Überschriften, keine Emojis.
- Nutze ausschließlich die Zahlen aus den DATEN. Erfinde keine Werte, keine Maßnahmen und keine Termine. Nenne Zahlen nur, wenn sie die Aussage stützen.
- Sei ehrlich: Wenn Werte gleich geblieben oder gesunken sind, sage das klar und ordne es plausibel ein (Google braucht nach Anpassungen Wochen bis Monate zum Neu-Crawlen und Neubewerten, Saison, Wettbewerb, unvollständiger Monat). Versprich keine bestimmten Rankings oder Ergebnisse.
- Unvollständige Monate (complete=false) nicht als Rückgang werten.
- Gibt es Optimierungen (optimizations), setze sie zeitlich zur Entwicklung in Bezug. Gibt es keine, nenne keine konkreten Maßnahmen.
- Falls ein Hinweis/eine Kundenfrage vorliegt, beantworte sie direkt und konkret.
- Schließe mit einem kurzen Ausblick, was als Nächstes sinnvoll ist (z. B. Suchanfragen mit vielen Impressionen, aber wenigen Klicks).
- Gib NUR den fertigen Text zurück.

DATEN:
Website: ${c.website || ""}${c.client ? " (" + c.client + ")" : ""}
Zeitraum: ${c.period || ""}
Gesamt: ${JSON.stringify(c.totals || {})}
Monate: ${JSON.stringify(c.months || [])}
Starke Suchanfragen: ${JSON.stringify(c.strongQueries || [])}
Potenzial-Suchanfragen: ${JSON.stringify(c.potentialQueries || [])}
Optimierungen/Live-Gänge: ${JSON.stringify(c.optimizations || [])}
${hint ? "HINWEIS/KUNDENFRAGE: " + hint : ""}
${existing ? "BISHERIGER TEXT (überarbeite/ergänze ihn, behalte Passendes): " + existing : ""}`;
}

app.post("/generate-report-note", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.months || !body.totals) {
      return res.status(400).json({ error: "Keine Report-Daten übermittelt." });
    }
    const raw = await callClaude(buildReportNotePrompt(body));
    const text = String(raw || "")
      .replace(/^```[a-z]*\s*|```\s*$/gi, "")
      .trim();
    if (!text) throw new Error("Die KI hat keinen Text geliefert.");
    res.json({ text });
  } catch (e) {
    console.error("Fehler bei /generate-report-note:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/analyze", async (req, res) => {
  try {
    const body = req.body || {};
    const url = body.url;
    if (!url) return res.status(400).json({ error: "url fehlt" });

    const mainHtml = await fetchHtml(url);
    const mainData = await extractPageData(mainHtml, url);

    // Falls die Kundenseite selbst noch keine Geo-Koordinaten hinterlegt hat, aber eine Adresse
    // erkannt wurde: echte Koordinaten per Geocoding nachschlagen (statt sie zu erfinden).
    if (!mainData.existingLat && (mainData.street || mainData.city)) {
      const geo = await geocodeAddress(mainData.street, mainData.zip, mainData.city, "Deutschland");
      if (geo) {
        mainData.existingLat = geo.lat;
        mainData.existingLng = geo.lng;
      }
    }

    const requestedPages = Array.isArray(body.pages) ? body.pages : [];
    const subpages = [];
    for (const p of requestedPages.slice(0, MAX_SUBPAGES)) {
      if (!p || !p.url) {
        subpages.push({ name: p && p.name, url: "" });
        continue;
      }
      try {
        const html = await fetchHtml(p.url);
        const data = await extractPageData(html, p.url);
        const imagesTotal = (data.images || []).length;
        const imagesMissingAltList = (data.images || [])
          .filter((img) => !img.alt)
          .slice(0, MAX_IMAGES)
          .map((img) => img.src);
        subpages.push({
          name: p.name,
          url: p.url,
          h1s: data.h1s,
          title: data.title,
          metaDesc: data.metaDesc,
          imagesTotal,
          imagesMissingAltList,
        });
      } catch (e) {
        subpages.push({ name: p.name, url: p.url, error: e.message });
      }
    }

    const input = {
      url,
      keywords: body.keywords || "",
      clientName: body.clientName || "",
      contactEmail: body.contactEmail || "",
      existingFaqItems: Array.isArray(body.faqItems)
        ? body.faqItems.filter((f) => f && (f.frage || f.antwort))
        : [],
      faqCount: Number.isFinite(body.faqCount) ? body.faqCount : MIN_FAQ_COUNT,
    };

    const prompt = buildPrompt(input, mainData, subpages);
    let ai;
    try {
      ai = extractJson(await callClaude(prompt));
    } catch (jsonErr) {
      // Ein einziger automatischer zweiter Versuch, falls die KI-Antwort trotz Reparaturversuch nicht
      // als JSON lesbar war (z. B. abgeschnitten oder strukturell kaputt).
      console.warn("KI-JSON ungültig, zweiter Versuch:", jsonErr.message);
      ai = extractJson(
        await callClaude(
          prompt +
            "\n\nHINWEIS: Deine vorherige Antwort war kein gültiges JSON. Antworte erneut mit dem VOLLSTÄNDIGEN Objekt als STRIKT gültiges JSON: Anführungszeichen innerhalb von Texten immer als \\\" maskieren (oder typografische „…“ nutzen), keine Zeilenumbrüche innerhalb von Texten, keine abschließenden Kommas."
        )
      );
    }
    const merged = mergeResult(ai, mainData, subpages, input);

    // Mindestanzahl FAQs absichern (nicht fatal: schlägt der Nachlauf fehl, bleibt die Liste wie sie ist)
    try {
      const plan = faqPlan(input);
      const missing = plan.keepOnly ? 0 : plan.total - (merged.faqItems || []).length;
      if (missing > 0) {
        input.faqTotal = plan.total;
        await fillMissingFaqs(merged, input, mainData, missing);
      }
    } catch (e) {
      console.error("FAQ-Nachlauf fehlgeschlagen (wird ignoriert):", e);
    }

    // Deterministischer 404-Check der internen Links auf der Zielseite (keine KI nötig – reiner
    // HTTP-Status-Check). Läuft parallel zu nichts anderem mehr an dieser Stelle, ist aber bewusst
    // nicht fatal: schlägt der Check komplett fehl (z. B. Netzwerkproblem), bricht die ganze
    // Analyse NICHT ab, sondern brokenLinks bleibt einfach leer.
    try {
      const brokenLinksFound = await findBrokenLinks(mainData.links);
      merged.brokenLinks = brokenLinksFound.map((b) => ({
        url: b.url,
        context: b.text ? 'Linktext „' + b.text + '"' : "",
      }));
    } catch (e) {
      console.error("404-Check fehlgeschlagen (wird ignoriert):", e);
    }

    res.json(merged);
  } catch (e) {
    console.error("Fehler bei /analyze:", e);
    res.status(500).json({ error: e.message });
  }
});

// Server nur starten, wenn die Datei direkt ausgeführt wird (nicht beim require() in Tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log("sellwerk-diy-proxy läuft auf Port " + PORT);
  });
}

module.exports = {
  app,
  extractPageData,
  buildPrompt,
  buildTextPrompt,
  faqPlan,
  fillMissingFaqs,
  extractJson,
  repairJson,
  mergeResult,
  absolutize,
  checkLinkStatus,
  findBrokenLinks,
};
