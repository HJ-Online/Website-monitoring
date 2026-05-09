const { chromium, request } = require("playwright");
const fs = require("fs");
const yaml = require("js-yaml");
const crypto = require("crypto");

const config = yaml.load(fs.readFileSync("sites.yml", "utf8"));
// Concurrency 1 = één site tegelijk afwerken, voorkomt server overload (503) op gedeelde hosting
const CONCURRENCY = Number(process.env.CONCURRENCY || 1);
const PAGE_CONCURRENCY = CONCURRENCY > 1 ? 2 : 3;
const GITHUB_USERNAME = "HJ-Online";

// ─── Utilities ────────────────────────────────────────────────────────────────

function safeFileName(text) {
  return text
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

function uniq(arr) {
  return [...new Set(arr)];
}

function formatMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function responseTimeClass(ms) {
  if (ms == null) return "";
  if (ms < 1500) return "rt-fast";
  if (ms < 3000) return "rt-medium";
  return "rt-slow";
}

// ─── History (persistent JSON per site) ───────────────────────────────────────

const HISTORY_FILE = "dashboard/history.json";
// NOTA: history.json gebruikt atomic rename voor crash-safety.
// Gelijktijdige runs worden voorkomen via concurrency: group: monitoring in de workflow.
// Bij horizontale scaling naar meerdere runners is een externe store (Redis/SQLite) nodig.

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Ongeldig formaat");
      return parsed;
    }
  } catch (e) {
    console.warn("⚠️  history.json onleesbaar of corrupt, start opnieuw:", e.message);
    const backup = HISTORY_FILE + ".corrupt." + Date.now();
    try { fs.renameSync(HISTORY_FILE, backup); } catch {}
  }
  return {};
}

function saveHistory(history) {
  const tmp = HISTORY_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
  fs.renameSync(tmp, HISTORY_FILE);
}

/**
 * Append a new run entry per site to history.
 * Keeps only the last 30 runs per site.
 */
function updateHistory(history, websites) {
  const now = new Date().toISOString();
  const activeSiteNames = new Set(websites.map(s => s.name));

  // Verwijder history van sites die niet meer in sites.yml staan
  for (const key of Object.keys(history)) {
    if (!activeSiteNames.has(key)) delete history[key];
  }

  for (const site of websites) {
    if (!history[site.name]) history[site.name] = [];

    history[site.name].push({
      ts: now,
      st: site.status[0], // "o"/"w"/"e" — 70% kleiner
      ok: site.ok,
      w: site.warning,
      e: site.error,
      rt: site.avgResponseMs ? Math.round(site.avgResponseMs) : null
    });

    if (history[site.name].length > 30) {
      history[site.name] = history[site.name].slice(-30);
    }
  }

  return history;
}

// ─── GitHub issue management ───────────────────────────────────────────────────

function isVisitorVisibleProblem(result) {
  if (result.status !== "error") return false;

  const details = result.details.join(" ").toLowerCase();

  const ignoredSignals = [
    "403", "bot", "cdn", "console meldingen", "favicon",
    "failed to load resource", "github-monitor geblokkeerd"
  ];

  const visitorSignals = [
    "geen response", "timeout (geen reactie", "net::err", "http fout",
    "tekst ontbreekt", "knop/tekst ontbreekt",
    "css bestand laadt niet", "javascript bestand laadt niet",
    "pagina lijkt niet goed gestyled", "te weinig zichtbare tekst",
    "te weinig afbeeldingen", "belangrijke selector ontbreekt",
    "server fout"
  ];

  const hasVisitorSignal = visitorSignals.some(s => details.includes(s));
  const onlyIgnored = ignoredSignals.some(s => details.includes(s)) && !hasVisitorSignal;

  return hasVisitorSignal && !onlyIgnored;
}

/**
 * Detect runner-wide network outage: if ALL sites have only timeout errors,
 * this is almost certainly a GitHub Actions infrastructure problem, not a
 * real website outage. Skip issue creation in that case.
 */
function isRunnerOutage(results, websites) {
  const errorSites = websites.filter(w => w.status === "error");
  if (errorSites.length < 2) return false; // Need at least 2 sites affected

  // Check if every single error result across ALL sites is a timeout
  const allErrorResults = results.filter(r => r.status === "error");
  if (allErrorResults.length === 0) return false;

  const allAreTimeouts = allErrorResults.every(r => r.isTimeout === true);

  // If every error is a bare timeout AND more than half of all sites are affected,
  // treat this as a runner outage
  const affectedFraction = errorSites.length / websites.length;
  return allAreTimeouts && affectedFraction >= 0.5;
}

/**
 * Fingerprint based only on stable identifiers: site name, path, and the
 * first keyword of the error type. Excludes response times and timestamps
 * so the same structural problem always gets the same hash — but a genuinely
 * new/different problem gets a new one.
 */
function createFingerprint(items) {
  const raw = items
    .map(r => {
      const firstDetail = r.details[0] || "";
      const errorType = firstDetail.split(":")[0].trim().toLowerCase().slice(0, 60);
      return `${r.site}|${r.path}|${errorType}`;
    })
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function findOpenMonitoringIssue(token, repo) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } }
  );
  if (!res.ok) return null;
  const issues = await res.json();
  return issues.find(i => i.title.startsWith("🚨 Website monitoring: bezoekersprobleem"));
}

async function addIssueComment(token, repo, issueNumber, body) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify({ body })
    }
  );
  return res.status;
}

async function createOrUpdateVisitorIssue(results, websites) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) { console.log("Geen GitHub token/repo. Issue overgeslagen."); return; }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) { console.error("Ongeldige GITHUB_REPOSITORY waarde. Afgebroken."); return; }

  const visitorProblems = results.filter(isVisitorVisibleProblem);
  if (visitorProblems.length === 0) { console.log("Geen bezoekersproblemen. Geen issue nodig."); return; }

  // Check for runner-wide network outage (all sites timeout = GitHub infra problem, not real outage)
  if (isRunnerOutage(results, websites)) {
    console.log("⚠️  Runner-wide timeout gedetecteerd — waarschijnlijk GitHub Actions netwerkprobleem. Geen issue aangemaakt.");
    return;
  }

  const dashboardUrl = process.env.DASHBOARD_URL || "https://hj-online.github.io/Website-monitoring/";
  const fingerprint = createFingerprint(visitorProblems);
  const existingIssue = await findOpenMonitoringIssue(token, repo);
  const checkedAt = new Date().toLocaleString("nl-NL");

  // Collect all previously seen fingerprints from issue body AND all comments
  let seenFingerprints = [];
  if (existingIssue) {
    const bodyMatches = [...(existingIssue.body || "").matchAll(/monitoring-fingerprint:([a-f0-9]{64})/g)];
    seenFingerprints = bodyMatches.map(m => m[1]);

    try {
      const commentsRes = await fetch(
        `https://api.github.com/repos/${repo}/issues/${existingIssue.number}/comments?per_page=100`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } }
      );
      if (commentsRes.ok) {
        const comments = await commentsRes.json();
        for (const c of comments) {
          const matches = [...(c.body || "").matchAll(/monitoring-fingerprint:([a-f0-9]{64})/g)];
          seenFingerprints.push(...matches.map(m => m[1]));
        }
      }
    } catch {}
  }

  if (seenFingerprints.includes(fingerprint)) {
    console.log("Zelfde structurele problemen al gemeld. Geen nieuwe notificatie."); return;
  }

  // ── Groepeer problemen per website voor een overzichtelijke mail ──
  const byWebsite = {};
  for (const r of visitorProblems.slice(0, 30)) {
    if (!byWebsite[r.site]) byWebsite[r.site] = { url: r.siteUrl, pages: [] };
    byWebsite[r.site].pages.push(r);
  }

  // Fouttype → korte leesbare label + actie-advies
  function errorLabel(detail) {
    const d = detail.toLowerCase();
    if (d.includes("http 503"))      return { icon: "🔴", label: "Server niet bereikbaar (503)", action: "Controleer hosting / herstart server" };
    if (d.includes("http 508"))      return { icon: "🔴", label: "Redirect-loop (508)", action: "WordPress: Instellingen → Permalinks → Opslaan" };
    if (d.includes("http 5"))        return { icon: "🔴", label: `Server fout (${detail.match(/HTTP \d+/)?.[0] || ""})`, action: "Controleer server logs" };
    if (d.includes("http 4"))        return { icon: "🔴", label: `Pagina niet gevonden (${detail.match(/HTTP \d+/)?.[0] || ""})`, action: "Controleer of de pagina bestaat" };
    if (d.includes("css bestand"))   return { icon: "🟠", label: "Styling ontbreekt (CSS 404)", action: "Elementor → Tools → Regenerate CSS" };
    if (d.includes("mixed content")) return { icon: "🟠", label: "HTTP/HTTPS conflict", action: "WordPress: Instellingen → Algemeen → URL naar https:// zetten" };
    if (d.includes("javascript"))    return { icon: "🟡", label: "Script laadt niet", action: "Controleer plugin of CDN" };
    if (d.includes("te weinig zichtbare tekst")) return { icon: "🟠", label: "Pagina lijkt leeg", action: "Open pagina in browser en controleer" };
    if (d.includes("te weinig afbeeldingen"))    return { icon: "🟡", label: "Afbeeldingen ontbreken", action: "Controleer afbeeldingen en CDN" };
    if (d.includes("timeout"))       return { icon: "🔴", label: "Pagina reageert niet (timeout)", action: "Controleer hosting / serverbelasting" };
    return { icon: "🟡", label: "Probleem gedetecteerd", action: "Bekijk details in dashboard" };
  }

  // Bouw een overzichtelijk blok per website
  function buildWebsiteBlock(siteName, siteData) {
    const lines = [`### ${siteName}`, `🔗 ${siteData.url}`, ""];
    const seen = new Set();
    for (const r of siteData.pages) {
      for (const detail of r.details) {
        const { icon, label, action } = errorLabel(detail);
        const key = label + r.path;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`**${icon} ${label}**`);
        lines.push(`↳ Pagina: \`${r.path}\``);
        lines.push(`↳ Actie: ${action}`);
        lines.push("");
      }
    }
    lines.push(`[Bekijk in dashboard](${dashboardUrl})`);
    return lines.join("\n");
  }

  const websiteBlocks = Object.entries(byWebsite)
    .map(([name, data]) => buildWebsiteBlock(name, data))
    .join("\n\n---\n\n");

  const errorCount   = websites.filter(w => w.status === "error").length;
  const warningCount = websites.filter(w => w.status === "warning").length;
  const okCount      = websites.filter(w => w.status === "ok").length;
  const totalSites   = websites.length;

  const statusBar = [
    okCount      ? `✅ ${okCount} OK`          : "",
    warningCount ? `⚠️ ${warningCount} waarschuwingen` : "",
    errorCount   ? `❌ ${errorCount} errors`    : "",
  ].filter(Boolean).join("  ·  ");

  const fingerLine = `<!-- monitoring-fingerprint:${fingerprint} -->`;

  const newIssueBody = [
    `@${GITHUB_USERNAME}`, "",
    fingerLine, "",
    "## 🚨 Websitemonitoring — actie vereist", "",
    `**Gedetecteerd:** ${checkedAt}  ·  **${totalSites} websites gecontroleerd**`,
    `**Status:** ${statusBar}`, "",
    `[→ Open dashboard](${dashboardUrl})`, "",
    "---", "",
    "## Problemen per website", "",
    websiteBlocks, "",
    "---",
    "> Sluit dit issue zodra het probleem is opgelost. De monitor maakt automatisch een nieuw issue aan bij nieuwe problemen."
  ].join("\n");

  const updateCommentBody = [
    `@${GITHUB_USERNAME}`, "",
    fingerLine, "",
    `## 🔄 Monitoring update — ${checkedAt}`, "",
    `**Status:** ${statusBar}  ·  [→ Dashboard](${dashboardUrl})`, "",
    "---", "",
    "## Nieuwe of gewijzigde problemen", "",
    websiteBlocks,
  ].join("\n");

  if (!existingIssue) {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify({ title: `🚨 Monitoring: ${errorCount} website(s) met errors — ${checkedAt}`, body: newIssueBody })
    });
    console.log("Nieuwe issue aangemaakt.", res.status);
  } else {
    const status = await addIssueComment(token, repo, existingIssue.number, updateCommentBody);
    console.log("Comment toegevoegd aan bestaand issue (notificatie verstuurd).", status);
  }
}


// ─── URL / page helpers ────────────────────────────────────────────────────────

function normalizePathFromUrl(pageUrl, baseUrl) {
  try {
    const url = new URL(pageUrl);
    const base = new URL(baseUrl);
    if (url.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) return null;
    return url.pathname || "/";
  } catch { return null; }
}

function isUsefulPage(url) {
  const lower = String(url).toLowerCase();
  const blocked = [
    "/wp-content/", "/wp-includes/", "/wp-json/", "/feed/", "/comments/",
    "/tag/", "/category/", "/author/", "/portfolio-category/", "/project-category/",
    "/cart/", "/winkelwagen/", "/checkout/", "/afrekenen/", "/my-account/", "/mijn-account/",
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".pdf", ".zip", ".xml"
  ];
  return !blocked.some(p => lower.includes(p));
}

function sortMenuPaths(paths) {
  const priority = [
    "/", "/home/", "/over-ons/", "/over/", "/diensten/", "/service/", "/services/",
    "/producten/", "/product/", "/assortiment/", "/tarieven/", "/prijzen/",
    "/cadeaubonnen/", "/reserveren/", "/afspraak-maken/", "/contact/", "/openingstijden/"
  ];
  return paths.sort((a, b) => {
    const ai = priority.indexOf(a), bi = priority.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.length - b.length;
  });
}

// ─── Browser context options ───────────────────────────────────────────────────

/**
 * Use a real desktop Chrome user-agent so Wordfence doesn't block us.
 * iPhone user-agents are aggressively filtered by many WAFs.
 */
const contextOptions = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 800 },
  extraHTTPHeaders: {
    "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
    // Cache-Control weggelaten: dit veroorzaakte CORS-errors op Google Fonts / gstatic voor alle sites
  }
};

// ─── Menu / sitemap discovery ──────────────────────────────────────────────────

async function getMenuUrls(browser, site) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const baseUrl = site.url.replace(/\/$/, "");

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2000);

    const links = await page.evaluate(() => {
      const selectors = [
        "header a", "nav a", ".menu a", ".main-menu a", ".primary-menu a",
        ".elementor-nav-menu a", ".elementor-location-header a", ".site-header a", ".navbar a"
      ];
      return Array.from(document.querySelectorAll(selectors.join(","))).map(a => a.href).filter(Boolean);
    });

    const menuPaths = uniq(
      links.map(l => normalizePathFromUrl(l, baseUrl)).filter(Boolean).filter(isUsefulPage)
        .map(p => p.endsWith("/") ? p : `${p}/`)
    );

    const fallback = site.pages || ["/"];
    const maxPages = Number(site.maxPages || 8);
    return uniq(["/", ...sortMenuPaths(menuPaths), ...fallback]).slice(0, maxPages);
  } catch (e) {
    console.log("Menu detectie mislukt bij:", site.name, e.message);
    return (site.pages || ["/"]).slice(0, Number(site.maxPages || 8));
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
  }
}

async function getSitemapUrls(requestContext, site) {
  const baseUrl = site.url.replace(/\/$/, "");
  const candidates = [
    `${baseUrl}/sitemap_index.xml`, `${baseUrl}/wp-sitemap.xml`,
    `${baseUrl}/page-sitemap.xml`, `${baseUrl}/sitemap.xml`
  ];
  const foundUrls = [];

  async function fetchXml(url) {
    try {
      const res = await requestContext.get(url, {
        timeout: 15000, failOnStatusCode: false,
        headers: { "User-Agent": contextOptions.userAgent, "Accept-Language": "nl-NL,nl;q=0.9" }
      });
      if (!res.ok()) return "";
      const text = await res.text();
      if (!text.includes("<urlset") && !text.includes("<sitemapindex")) return "";
      return text;
    } catch { return ""; }
  }

  function extractLocs(xml) {
    return [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(m => m[1].trim().replace(/&amp;/g, "&"));
  }

  for (const sitemapUrl of candidates) {
    const xml = await fetchXml(sitemapUrl);
    if (!xml) continue;
    const locs = extractLocs(xml);
    const childSitemaps = locs.filter(l => l.toLowerCase().includes("sitemap"));
    foundUrls.push(...locs.filter(l => !l.toLowerCase().includes("sitemap")));
    for (const child of childSitemaps.slice(0, 8)) {
      const childXml = await fetchXml(child);
      if (childXml) foundUrls.push(...extractLocs(childXml));
    }
    if (foundUrls.length > 0) break;
  }

  const paths = uniq(foundUrls.filter(isUsefulPage).map(u => normalizePathFromUrl(u, baseUrl)).filter(Boolean));
  const fallback = site.pages || ["/"];
  const maxPages = Number(site.maxPages || 8);
  return uniq(["/", ...(paths.length ? paths : fallback)]).slice(0, maxPages);
}

// ─── Parallel runner ───────────────────────────────────────────────────────────

async function runParallel(tasks, limit) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

// ─── Frontend health checks ────────────────────────────────────────────────────

async function runFrontendHealthChecks(page, site, details) {
  const health = await page.evaluate(() => {
    const bodyText = document.body?.innerText?.replace(/\s+/g, " ").trim() || "";

    const visibleImages = Array.from(document.images).filter(img => {
      const rect = img.getBoundingClientRect();
      const style = window.getComputedStyle(img);
      return rect.width > 30 && rect.height > 30 && style.display !== "none" && style.visibility !== "hidden";
    }).length;

    const visibleButtons = Array.from(document.querySelectorAll("a, button, input[type='submit']")).filter(el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 20 && rect.height > 20 && style.display !== "none" && style.visibility !== "hidden";
    }).length;

    const stylesheets = Array.from(document.styleSheets || []).length;
    return { textLength: bodyText.length, visibleImages, visibleButtons, stylesheets };
  });

  const minTextLength = Number(site.minTextLength || 250);
  const minImages = Number(site.minImages ?? 1);
  const minButtons = Number(site.minButtons ?? 1);

  if (health.textLength < minTextLength)
    details.push(`Te weinig zichtbare tekst (${health.textLength} tekens). Mogelijk kapotte frontend.`);
  if (health.visibleImages < minImages)
    details.push(`Te weinig afbeeldingen zichtbaar (${health.visibleImages}). Mogelijk laden afbeeldingen/layout niet.`);
  if (health.visibleButtons < minButtons)
    details.push(`Te weinig knoppen/links zichtbaar (${health.visibleButtons}). Mogelijk menu of CTA kapot.`);
  if (health.stylesheets === 0)
    details.push("Pagina lijkt niet goed gestyled: geen stylesheets actief.");

  for (const selector of site.requiredSelectors || []) {
    const exists = await page.locator(selector).first().count();
    if (!exists) details.push("Belangrijke selector ontbreekt: " + selector);
  }
}

// ─── Main page check ───────────────────────────────────────────────────────────

async function checkPage(browser, site, path, isRetry = false) {
  const url = site.url.replace(/\/$/, "") + path;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  const failedAssets = [];

  page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("response", response => {
    const rt = response.request().resourceType();
    const st = response.status();
    if (["stylesheet", "script"].includes(rt) && st >= 400)
      failedAssets.push({ type: rt, status: st, url: response.url() });
  });
  page.on("requestfailed", req => {
    if (["stylesheet", "script", "image"].includes(req.resourceType()))
      failedAssets.push({ type: req.resourceType(), status: "failed", url: req.url() });
  });

  let status = "ok";
  const details = [];
  const screenshotName = `${safeFileName(site.name + "-" + path)}.png`;
  let screenshot = null;
  let skipFrontendChecks = false;
  let responseTimeMs = null;

  try {
    const start = Date.now();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    responseTimeMs = Date.now() - start;

    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});

    const httpStatus = response?.status();

    if (!response) {
      status = "error";
      details.push("Geen response ontvangen");
    } else if (httpStatus === 403) {
      // Keep trying with a short wait — sometimes 403 is transient behind a CDN
      // If still 403 after retry, mark as warning (not error) so we know it's blocked
      status = "warning";
      skipFrontendChecks = true;
      details.push("Geblokkeerd door beveiligingsplugin (403). Controleer of normale bezoekers de site kunnen zien.");
    } else if (httpStatus >= 500) {
      status = "error";
      details.push(`Server fout: HTTP ${httpStatus}`);
    } else if (httpStatus >= 400) {
      status = "error";
      details.push(`HTTP fout: ${httpStatus}`);
    }

    if (!skipFrontendChecks) {
      const html = await page.content();
      const htmlLower = html.toLowerCase();

      for (const text of site.requiredText || []) {
        if (!htmlLower.includes(text.toLowerCase())) {
          status = "error";
          details.push("Tekst ontbreekt: " + text);
        }
      }

      for (const btnText of site.requiredButtons || []) {
        if (!htmlLower.includes(btnText.toLowerCase())) {
          status = "error";
          details.push("Knop/tekst ontbreekt: " + btnText);
        }
      }

      await runFrontendHealthChecks(page, site, details);

      // Externe CDN-domeinen die geen echte bezoekersproblemen zijn
      const ignoredAssetDomains = [
        "fonts.gstatic.com",
        "fonts.googleapis.com",
        "gstatic.com",
        "recaptcha",
        "google-analytics.com",
        "googletagmanager.com",
        "hotjar.com",
        "facebook.net",
        "doubleclick.net"
      ];
      const isIgnoredAsset = url => ignoredAssetDomains.some(d => url.includes(d));

      const failedCss = failedAssets.filter(a => a.type === "stylesheet" && !isIgnoredAsset(a.url));
      const failedJs  = failedAssets.filter(a => a.type === "script"     && !isIgnoredAsset(a.url));

      if (failedCss.length > 0) {
        status = "error";
        details.push("CSS bestand laadt niet: " + failedCss.slice(0, 2).map(a => `${a.status} ${a.url}`).join(" | "));
      }
      if (failedJs.length > 0)
        details.push("Javascript bestand laadt niet: " + failedJs.slice(0, 2).map(a => `${a.status} ${a.url}`).join(" | "));

      const filteredErrors = errors.filter(e =>
        !e.includes("403") &&
        !e.includes("favicon") &&
        !e.includes("Failed to load resource") &&
        !e.includes("fonts.gstatic.com") &&
        !e.includes("fonts.googleapis.com") &&
        !e.includes("gstatic.com") &&
        !e.includes("CORS") &&
        !e.includes("recaptcha") &&
        !e.includes("google-analytics") &&
        !e.includes("googletagmanager") &&
        !e.includes("hotjar") &&
        !e.includes("facebook")
      );
      if (filteredErrors.length > 0)
        details.push("Console meldingen: " + filteredErrors.slice(0, 3).join(" | "));

      if (details.some(d =>
        d.includes("Te weinig zichtbare tekst") || d.includes("Te weinig afbeeldingen") ||
        d.includes("Te weinig knoppen") || d.includes("Pagina lijkt niet goed gestyled") ||
        d.includes("Belangrijke selector ontbreekt")
      )) status = "error";

      // Trage laadtijd: waarschuw bij > 3s (Google's grens voor mobiele SEO)
      if (responseTimeMs > 3000 && status !== "error") {
        status = "warning";
        details.push(`Trage laadtijd: ${formatMs(responseTimeMs)}. Google adviseert onder de 3 seconden voor goede SEO-ranking.`);
      }
    }

    const shouldTakeScreenshot = status !== "ok" || path === "/";
  if (shouldTakeScreenshot && !skipFrontendChecks) {
      try {
        const safePath = `dashboard/${screenshotName}`;
        const resolved = require("path").resolve(safePath);
        const dashboardDir = require("path").resolve("dashboard");
        if (resolved.startsWith(dashboardDir + require("path").sep)) {
          await page.screenshot({ path: safePath, fullPage: false, clip: { x: 0, y: 0, width: 1280, height: 900 } });
          screenshot = screenshotName;
        }
      } catch {}
    }
  } catch (e) {
  try { await page.close(); } catch {}
  try { await context.close(); } catch {}

    const isTimeout = e.message.includes("Timeout") || e.message.includes("timeout");

    // Retry once on timeout before marking as error — catches flaky runner network
  if (isTimeout && !isRetry) {
      const backoff = 5000 + Math.random() * 3000;
      console.log(`  Timeout op ${url} — herproberen na ${Math.round(backoff / 1000)}s...`);
      await new Promise(r => setTimeout(r, backoff));
      return checkPage(browser, site, path, true);
    }

    // If it was a timeout on retry (or a non-timeout error), mark as error
    // But flag it so the issue-logic can detect runner-wide outages
    const label = isTimeout ? "Timeout (geen reactie van server)" : e.message;
    return {
      site: site.name,
      siteUrl: site.url,
      path,
      url,
      status: "error",
      details: [label],
      checkedAt: new Date().toLocaleString("nl-NL"),
      screenshot: null,
      responseTimeMs: null,
      isTimeout
    };
  }

  try { await page.close(); } catch {}
  try { await context.close(); } catch {}

  return {
    site: site.name,
    siteUrl: site.url,
    path,
    url,
    status,
    details: details.length ? details : ["Alles lijkt goed"],
    checkedAt: new Date().toLocaleString("nl-NL"),
    screenshot,
    responseTimeMs
  };
}

// ─── Dashboard HTML ────────────────────────────────────────────────────────────

function buildUptimeBadges(historyEntries) {
  if (!historyEntries || historyEntries.length === 0) return '<span style="color:var(--muted);font-size:12px">Geen historie</span>';

  return historyEntries.slice(-14).map(entry => {
    const s = entry.st || entry.status; // backwards compat
    const color = s === "o" || s === "ok" ? "var(--success)" : s === "w" || s === "warning" ? "var(--warning)" : "var(--danger)";
    const date = new Date(entry.ts).toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
    return `<span title="${date}: ${entry.status}" style="display:inline-block;width:10px;height:22px;border-radius:3px;background:${color};margin:0 1px;opacity:0.85;cursor:default;"></span>`;
  }).join("");
}

function uptimePercentage(historyEntries) {
  if (!historyEntries || historyEntries.length === 0) return null;
  const ok = historyEntries.filter(e => (e.st || e.status) === "o" || (e.st || e.status) === "ok").length;
  return Math.round((ok / historyEntries.length) * 100);
}

function buildDashboard(websites, history) {
  const totalPages = websites.reduce((s, w) => s + w.total, 0);
  const totalWebsites = websites.length;
  const okWebsites = websites.filter(w => w.status === "ok").length;
  const warningWebsites = websites.filter(w => w.status === "warning").length;
  const errorWebsites = websites.filter(w => w.status === "error").length;
  const lastCheck = new Date().toLocaleString("nl-NL");

  const avgResponseAll = websites
    .map(w => w.avgResponseMs)
    .filter(v => v != null);
  const avgResponse = avgResponseAll.length
    ? Math.round(avgResponseAll.reduce((a, b) => a + b, 0) / avgResponseAll.length)
    : null;

  const websiteRows = websites.map((site, siteIndex) => {
    const hist = history[site.name] || [];
    const uptime = uptimePercentage(hist);
    const uptimeBadges = buildUptimeBadges(hist);

    const pageRows = site.pages.map((p, pageIndex) => {
      const screenshotHtml = p.screenshot
        ? `<div class="actions"><a class="button-link" href="${esc(p.url)}" target="_blank">Pagina openen</a><a class="button-link secondary-link" href="${esc(p.screenshot)}" target="_blank">Screenshot</a></div>`
        : `<div class="actions"><a class="button-link" href="${esc(p.url)}" target="_blank">Pagina openen</a><span class="no-screenshot">Geen screenshot beschikbaar of niet nodig</span></div>`;

      const previewHtml = p.screenshot
        ? `<a href="${esc(p.screenshot)}" target="_blank"><img class="screenshot-preview" src="${esc(p.screenshot)}" loading="lazy" alt="Screenshot ${esc(p.site)}"></a>`
        : `<div class="no-preview">Geen screenshot beschikbaar</div>`;

      const rtHtml = p.responseTimeMs != null
        ? `<span class="rt-badge ${responseTimeClass(p.responseTimeMs)}">${formatMs(p.responseTimeMs)}</span>`
        : "";

      return `
        <tr class="page-row page-of-${siteIndex}" style="display:none" data-status="${esc(p.status)}">
          <td>
            <div class="page-indent">
              <strong>${esc(p.path)}</strong>
              <div class="muted">${esc(p.url)}</div>
            </div>
          </td>
          <td><span class="badge badge-${esc(p.status)}">${esc(p.status)}</span></td>
          <td>${p.details.map(d => `<div>${esc(d)}</div>`).join("")}</td>
          <td>${rtHtml}</td>
          <td>${esc(p.checkedAt)}</td>
          <td class="num">
            <button class="secondary" type="button" onclick="togglePageDetails('${siteIndex}-${pageIndex}')">Details</button>
          </td>
        </tr>
        <tr id="page-details-${siteIndex}-${pageIndex}" class="page-detail-row page-of-${siteIndex}" style="display:none">
          <td colspan="6">
            <div class="detail-box">
              <div>
                <label>Pagina controle</label>
                <div class="hint">${p.details.map(d => `<div>• ${esc(d)}</div>`).join("")}</div>
                ${screenshotHtml}
              </div>
              <div>
                <label>Screenshot</label>
                ${previewHtml}
              </div>
            </div>
          </td>
        </tr>`;
    }).join("");

    const rtBadge = site.avgResponseMs != null
      ? `<span class="rt-badge ${responseTimeClass(site.avgResponseMs)}" title="Gemiddelde laadtijd">${formatMs(site.avgResponseMs)}</span>`
      : "";

    const uptimeHtml = uptime != null
      ? `<span class="uptime-pct ${uptime === 100 ? "positive" : uptime >= 90 ? "warning" : "danger"}">${uptime}%</span>`
      : "";

    return `
      <tr class="website-row ${esc(site.status)}" data-index="${siteIndex}" data-status="${esc(site.status)}" data-site="${esc(site.name.toLowerCase())}">
        <td class="customer">
          ${esc(site.name)}
          <div class="muted">${esc(site.siteUrl)}</div>
        </td>
        <td><span class="badge badge-${esc(site.status)}">${esc(site.status)}</span></td>
        <td>
          <span class="tag positive">${site.ok} OK</span>
          <span class="tag warning">${site.warning} warnings</span>
          <span class="tag danger">${site.error} errors</span>
          <span class="tag">${site.total} pag.</span>
        </td>
        <td>${rtBadge}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            ${uptimeBadges}
            ${uptimeHtml}
          </div>
        </td>
        <td>${esc(site.lastCheck)}</td>
        <td class="num">
          <button type="button" onclick="toggleSitePages(${siteIndex})">Pagina's openen</button>
        </td>
      </tr>
      ${pageRows}`;
  }).join("");

  const problemRows = websites
    .filter(w => w.status !== "ok")
    .map(w => `
      <div class="status-row">
        <div>
          <strong>${esc(w.name)}</strong>
          <div class="muted">${w.error} errors · ${w.warning} warnings · ${w.total} pagina's</div>
        </div>
        <span class="${w.status === "error" ? "danger" : "warning"}">${esc(w.status)}</span>
      </div>`).join("");

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HJ Online Website Monitoring</title>
<style>
:root{
  --bg:#f4f7fb;--card:#fff;--text:#111827;--muted:#667085;--line:#e5eef7;
  --accent:#1e6eeb;--accent-dark:#1458c8;--accent-soft:#eff4ff;
  --shadow:0 2px 8px rgba(17,24,39,.07);--radius:16px;
  --success:#027a48;--success-soft:#ecfdf3;--success-border:#6ce9a6;
  --warning:#b54708;--warning-soft:#fffaeb;--warning-border:#fec84b;
  --danger:#b42318;--danger-soft:#fef3f2;--danger-border:#fda29b;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5}
header{padding:28px 32px 24px;background:#fff;border-bottom:1px solid var(--line)}
.header-top{display:flex;align-items:center;gap:12px;margin-bottom:4px}
.logo{display:inline-flex;padding:5px 12px;border-radius:999px;background:var(--accent-soft);color:var(--accent-dark);font-weight:700;font-size:12px;letter-spacing:.04em}
header h1{font-size:22px;font-weight:700;letter-spacing:-.02em}
header p{color:var(--muted);font-size:13px;max-width:800px;margin-top:4px}
main{padding:24px 32px;max-width:1600px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:20px}
.kpi-title{color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.kpi-value{font-size:30px;font-weight:800;margin-top:6px;letter-spacing:-.03em}
.kpi-sub{color:var(--muted);font-size:11px;margin-top:4px}
.kpi-value.positive{color:var(--success)}
.kpi-value.warning{color:var(--warning)}
.kpi-value.danger{color:var(--danger)}
.management{display:grid;grid-template-columns:1.2fr .8fr;gap:14px;margin-bottom:20px}
.status-row{display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding:10px 0}
.status-row:last-child{border-bottom:0}
.positive{color:var(--success);font-weight:700}
.warning{color:var(--warning);font-weight:700}
.danger{color:var(--danger);font-weight:700}
.muted{color:var(--muted);font-size:12px;margin-top:2px}
.hint{color:var(--muted);font-size:13px;line-height:1.6}
.toolbar{display:grid;grid-template-columns:1fr 180px 180px;gap:10px;margin-bottom:14px}
input,select{width:100%;border:1px solid var(--line);border-radius:8px;padding:9px 12px;background:#fff;color:var(--text);outline:none;font-size:13px}
input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(30,110,235,.1)}
button,.button-link{border:0;border-radius:999px;padding:8px 14px;background:var(--accent);color:#fff;font-weight:600;font-size:12px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:4px;transition:background .15s}
button:hover,.button-link:hover{background:var(--accent-dark)}
button.secondary,.secondary-link{background:var(--accent-soft);color:var(--accent-dark);box-shadow:none}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center}
h3{font-size:15px;font-weight:700;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:8px 12px}
.num{text-align:right;white-space:nowrap}
.customer{font-weight:600;font-size:13px}
tr:hover td{background:#fafcff}
.badge,.tag{display:inline-flex;border-radius:999px;padding:3px 9px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:1px}
.badge-ok,.tag.positive{background:var(--success-soft);color:var(--success);border:1px solid var(--success-border)}
.badge-warning,.tag.warning{background:var(--warning-soft);color:var(--warning);border:1px solid var(--warning-border)}
.badge-error,.tag.danger{background:var(--danger-soft);color:var(--danger);border:1px solid var(--danger-border)}
.tag{background:var(--accent-soft);color:var(--accent-dark);border:1px solid rgba(30,110,235,.2)}
.website-row.error td{background:#fffafa}
.website-row.warning td{background:#fffdf5}
.page-row td{background:#fff;font-size:12px}
.page-indent{padding-left:24px;border-left:3px solid var(--accent-soft)}
.page-detail-row td{background:#fafcff!important}
.detail-box{display:grid;grid-template-columns:1fr 300px;gap:16px;padding:16px;border:1px solid var(--line);border-radius:12px;background:#fff}
label{display:block;font-size:11px;color:var(--muted);margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.screenshot-preview{width:100%;max-height:220px;object-fit:cover;border:1px solid var(--line);border-radius:10px}
.no-screenshot,.no-preview{display:flex;align-items:center;justify-content:center;border:1px dashed var(--line);border-radius:10px;color:var(--muted);font-size:12px;padding:14px;min-height:60px}
.no-preview{min-height:150px}
.table-wrap{overflow:auto}
.empty{padding:32px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:12px;display:none}

/* Response time badges */
.rt-badge{display:inline-flex;border-radius:6px;padding:2px 7px;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
.rt-fast{background:#ecfdf3;color:#027a48}
.rt-medium{background:#fffaeb;color:#b54708}
.rt-slow{background:#fef3f2;color:#b42318}

/* Uptime */
.uptime-pct{font-size:11px;font-weight:700;margin-left:4px}

@media(max-width:1100px){.grid{grid-template-columns:repeat(3,1fr)}.management,.toolbar{grid-template-columns:1fr}main,header{padding:16px}}
@media(max-width:640px){.grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<header>
  <div class="header-top">
    <span class="logo">HJ Online</span>
  </div>
  <h1>Website Monitoring Dashboard</h1>
  <p>Automatische controle van WordPress- en WooCommerce-websites. Bijgewerkt op ${esc(lastCheck)}. <span id="nextCheck"></span></p>
<script>
(function(){
  const now = new Date();
  const h = now.getHours();
  const next = new Date(now);
  if (h < 8) { next.setHours(8,0,0,0); }
  else if (h < 20) { next.setHours(20,0,0,0); }
  else { next.setDate(next.getDate()+1); next.setHours(8,0,0,0); }
  const diff = Math.round((next - now) / 60000);
  const hrs = Math.floor(diff/60), mins = diff%60;
  document.getElementById('nextCheck').textContent =
    '· Volgende check over ' + (hrs ? hrs+'u ' : '') + mins + 'm';
  setTimeout(() => location.reload(), (next - now));
})();
</script>
</header>

<main>
  <section class="grid">
    <div class="card">
      <div class="kpi-title">Websites</div>
      <div class="kpi-value">${totalWebsites}</div>
      <div class="kpi-sub">Actief gemonitord</div>
    </div>
    <div class="card">
      <div class="kpi-title">Pagina checks</div>
      <div class="kpi-value">${totalPages}</div>
      <div class="kpi-sub">Menu/core pagina's</div>
    </div>
    <div class="card">
      <div class="kpi-title">OK</div>
      <div class="kpi-value positive">${okWebsites}</div>
      <div class="kpi-sub">Alles groen</div>
    </div>
    <div class="card">
      <div class="kpi-title">Warnings</div>
      <div class="kpi-value warning">${warningWebsites}</div>
      <div class="kpi-sub">Aandacht nodig</div>
    </div>
    <div class="card">
      <div class="kpi-title">Errors</div>
      <div class="kpi-value danger">${errorWebsites}</div>
      <div class="kpi-sub">Direct controleren</div>
    </div>
  </section>

  <section class="management">
    <div class="card">
      <h3>Managementsamenvatting</h3>
      <div class="status-row"><strong>Laatste controle</strong><span>${esc(lastCheck)}</span></div>
      <div class="status-row"><strong>Algemene status</strong><span class="${errorWebsites ? "danger" : warningWebsites ? "warning" : "positive"}">${errorWebsites ? "Errors gevonden — direct actie vereist" : warningWebsites ? "Waarschuwingen aanwezig" : "Alles lijkt goed"}</span></div>
      <div class="status-row"><strong>Structuur</strong><span>${totalWebsites} websites · ${totalPages} pagina's</span></div>
      ${avgResponse != null ? `<div class="status-row"><strong>Gem. laadtijd</strong><span class="rt-badge ${responseTimeClass(avgResponse)}">${formatMs(avgResponse)}</span></div>` : ""}
    </div>

    <div class="card">
      <h3>Controle & aandachtspunten</h3>
      ${problemRows || `<div class="status-row"><strong>Geen aandachtspunten</strong><span class="positive">Alle websites zijn groen</span></div>`}
    </div>
  </section>

  <section class="card">
    <h3>Websites</h3>
    <p class="hint" style="margin-bottom:14px">Klap een website uit voor pagina's, details en screenshots. De gekleurde balkjes tonen de status van de laatste 14 checks.</p>

    <div class="toolbar">
      <input id="searchInput" type="text" placeholder="Zoeken op website of URL..." oninput="filterRows()">
      <select id="statusFilter" onchange="filterRows()">
        <option value="">Alle statussen</option>
        <option value="ok">Alleen OK</option>
        <option value="warning">Alleen warnings</option>
        <option value="error">Alleen errors</option>
      </select>
      <select id="sortFilter" onchange="sortRows()">
        <option value="default">Standaard volgorde</option>
        <option value="status">Errors bovenaan</option>
        <option value="site">Website A-Z</option>
      </select>
    </div>

    <div class="table-wrap">
      <table id="checksTable">
        <thead>
          <tr>
            <th>Website</th>
            <th>Status</th>
            <th>Pagina's</th>
            <th>Laadtijd</th>
            <th>Uptime (14 checks)</th>
            <th>Laatste check</th>
            <th class="num">Details</th>
          </tr>
        </thead>
        <tbody id="tableBody">
          ${websiteRows}
        </tbody>
      </table>
    </div>

    <div id="emptyState" class="empty">Geen websites gevonden.</div>
  </section>
</main>

<script>
function toggleSitePages(siteIndex) {
  const rows = document.querySelectorAll(".page-of-" + siteIndex);
  const first = rows[0];
  if (!first) return;
  const open = first.style.display === "none";
  rows.forEach(row => {
    if (row.classList.contains("page-detail-row")) row.style.display = "none";
    else row.style.display = open ? "table-row" : "none";
  });
}

function togglePageDetails(id) {
  const row = document.getElementById("page-details-" + id);
  if (row) row.style.display = row.style.display === "none" ? "table-row" : "none";
}

let filterTimer;
function filterRows() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    const q = document.getElementById("searchInput").value.toLowerCase();
    const status = document.getElementById("statusFilter").value;
    const rows = document.querySelectorAll(".website-row");
    let visible = 0;
    rows.forEach(row => {
      const nameMatch = row.dataset.site.includes(q);
      const match = (nameMatch || (q.length > 1 && row.innerText.toLowerCase().includes(q))) &&
                    (!status || row.dataset.status === status);
      row.style.display = match ? "table-row" : "none";
      if (!match) {
        document.querySelectorAll(".page-of-" + row.dataset.index).forEach(p => p.style.display = "none");
      }
      if (match) visible++;
    });
    document.getElementById("emptyState").style.display = visible ? "none" : "block";
  }, 80);
}

function sortRows() {
  const mode = document.getElementById("sortFilter").value;
  const tbody = document.getElementById("tableBody");
  const rows = Array.from(tbody.querySelectorAll(".website-row"));
  const rank = { error: 0, warning: 1, ok: 2 };
  rows.sort((a, b) => {
    if (mode === "status") return rank[a.dataset.status] - rank[b.dataset.status];
    if (mode === "site") return a.dataset.site.localeCompare(b.dataset.site);
    return Number(a.dataset.index) - Number(b.dataset.index);
  });
  rows.forEach(row => {
    const related = Array.from(document.querySelectorAll(".page-of-" + row.dataset.index));
    tbody.appendChild(row);
    related.forEach(p => { p.style.display = "none"; tbody.appendChild(p); });
  });
  filterRows();
}
</script>
</body>
</html>`;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  fs.mkdirSync("dashboard", { recursive: true });

  // Verwijder screenshots van vorige runs (bewaar alleen history.json en index.html)
  try {
    const dashFiles = fs.readdirSync("dashboard");
    for (const f of dashFiles) {
      if (f.endsWith(".png")) fs.unlinkSync(`dashboard/${f}`);
    }
  } catch (e) {
    console.warn("⚠️  Screenshot cleanup mislukt:", e.message);
  }

  const history = loadHistory();
  const browser = await chromium.launch();
  const requestContext = await request.newContext();

  async function resolvePages(site) {
    try {
      let pages;
      if (site.sitemap === "menu") {
        pages = await getMenuUrls(browser, site);
        if (!pages.includes("/")) pages.unshift("/");
      } else if (site.sitemap) {
        pages = await getSitemapUrls(requestContext, site);
      } else {
        pages = site.pages || ["/"];
      }
      if (!pages || pages.length === 0) pages = site.pages || ["/"];
      return pages;
    } catch (e) {
      console.log("Pagina detectie fout bij:", site.name, e.message);
      return site.pages || ["/"];
    }
  }

  // Menu-detectie parallel uitvoeren (max 3 tegelijk — lichte HTTP-requests)
  const MENU_CONCURRENCY = 3;
  const sites = config.sites || [];
  const resolvedPages = await runParallel(
    sites.map(site => () => resolvePages(site)),
    MENU_CONCURRENCY
  );

  const tasks = sites.map((site, i) => async () => {
    const pages = resolvedPages[i];
    const PAGE_CONCURRENCY = 3;
    const chunks = [];
    for (let idx = 0; idx < pages.length; idx += PAGE_CONCURRENCY) {
      chunks.push(pages.slice(idx, idx + PAGE_CONCURRENCY));
    }
    const siteResults = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunkResults = await Promise.all(chunks[ci].map(path => checkPage(browser, site, path)));
      siteResults.push(...chunkResults);
      if (ci < chunks.length - 1) await new Promise(r => setTimeout(r, 800));
    }
    return siteResults;
  });

  // Sites worden parallel verwerkt (CONCURRENCY), pagina's per site sequentieel
  const nestedResults = await runParallel(tasks, CONCURRENCY);
  const results = nestedResults.flat();

  await requestContext.dispose();
  await browser.close();

  // Group results by site
  const grouped = {};
  for (const r of results) {
    if (!grouped[r.site]) grouped[r.site] = { name: r.site, siteUrl: r.siteUrl, pages: [] };
    grouped[r.site].pages.push(r);
  }

  const websites = Object.values(grouped).map(site => {
    const hasError = site.pages.some(p => p.status === "error");
    const hasWarning = site.pages.some(p => p.status === "warning");
    const times = site.pages.map(p => p.responseTimeMs).filter(t => t != null).sort((a, b) => a - b);
    const avgResponseMs = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
    const p95ResponseMs = times.length ? times[Math.floor(times.length * 0.95)] ?? times[times.length - 1] : null;

    return {
      ...site,
      status: hasError ? "error" : hasWarning ? "warning" : "ok",
      ok: site.pages.filter(p => p.status === "ok").length,
      warning: site.pages.filter(p => p.status === "warning").length,
      error: site.pages.filter(p => p.status === "error").length,
      total: site.pages.length,
      lastCheck: site.pages[site.pages.length - 1]?.checkedAt || "",
      avgResponseMs,
      p95ResponseMs
    };
  });

  // Update and save history
  const updatedHistory = updateHistory(history, websites);
  saveHistory(updatedHistory);

  // Create GitHub issue if needed
  await createOrUpdateVisitorIssue(results, websites);

  // Write dashboard
  const html = buildDashboard(websites, updatedHistory);
  fs.writeFileSync("dashboard/index.html", html);

  console.log(`\n✅ Dashboard klaar — ${websites.length} websites, ${results.length} pagina checks`);
  console.log(`   OK: ${websites.filter(w => w.status === "ok").length} | Warnings: ${websites.filter(w => w.status === "warning").length} | Errors: ${websites.filter(w => w.status === "error").length}`);
})();
