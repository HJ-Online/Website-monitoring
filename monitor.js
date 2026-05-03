const { chromium, request } = require("playwright");
const fs = require("fs");
const yaml = require("js-yaml");
const crypto = require("crypto");

const config = yaml.load(fs.readFileSync("sites.yml", "utf8"));
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const GITHUB_USERNAME = "HJ-Online";

function safeFileName(text) {
  return text
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[m]));
}

function uniq(arr) {
  return [...new Set(arr)];
}

function isVisitorVisibleProblem(result) {
  if (result.status !== "error") return false;

  const details = result.details.join(" ").toLowerCase();

  const ignoredSignals = [
    "403",
    "bot",
    "cdn",
    "console meldingen",
    "favicon",
    "failed to load resource"
  ];

  const visitorSignals = [
    "geen response",
    "timeout",
    "net::err",
    "http fout",
    "tekst ontbreekt",
    "knop/tekst ontbreekt",
    "page.goto",
    "navigation"
  ];

  const hasVisitorSignal = visitorSignals.some(signal => details.includes(signal));
  const onlyIgnored = ignoredSignals.some(signal => details.includes(signal)) && !hasVisitorSignal;

  return hasVisitorSignal && !onlyIgnored;
}

function createFingerprint(items) {
  const raw = items
    .map(r => `${r.site}|${r.path}|${r.status}|${r.details.join("|")}`)
    .sort()
    .join("\n");

  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function findOpenMonitoringIssue(token, repo) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }
  );

  if (!response.ok) {
    console.log("Open issues ophalen mislukt:", response.status, await response.text());
    return null;
  }

  const issues = await response.json();

  return issues.find(issue =>
    issue.title.startsWith("🚨 Website monitoring: bezoekersprobleem")
  );
}

async function createOrUpdateVisitorIssue(results, websites) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;

  if (!token || !repo) {
    console.log("Geen GitHub token/repo beschikbaar. Issue overgeslagen.");
    return;
  }

  const visitorProblems = results.filter(isVisitorVisibleProblem);

  if (visitorProblems.length === 0) {
    console.log("Geen bezoekersproblemen gevonden. Geen issue/mail nodig.");
    return;
  }

  const dashboardUrl = process.env.DASHBOARD_URL || "https://hj-online.github.io/Website-monitoring/";
  const fingerprint = createFingerprint(visitorProblems);
  const existingIssue = await findOpenMonitoringIssue(token, repo);

  if (existingIssue?.body?.includes(`monitoring-fingerprint:${fingerprint}`)) {
    console.log("Zelfde bezoekersproblemen bestaan al. Geen nieuwe issue/mail.");
    return;
  }

  const body = `@${GITHUB_USERNAME}

<!-- monitoring-fingerprint:${fingerprint} -->

Er zijn problemen gevonden die waarschijnlijk zichtbaar zijn voor normale websitebezoekers.

## Samenvatting

- Kritieke pagina’s: ${visitorProblems.length}
- Websites met error: ${websites.filter(w => w.status === "error").length}
- Dashboard: ${dashboardUrl}

## Problemen

${visitorProblems.slice(0, 20).map(r => `### ❌ ${r.site} — ${r.path}

**URL:** ${r.url}

**Details:**
${r.details.map(d => `- ${d}`).join("\n")}

**Tijd:** ${r.checkedAt}
`).join("\n---\n")}

---

Deze melding wordt alleen gemaakt bij bezoekersproblemen zoals HTTP-fouten, timeouts, ontbrekende verplichte content of ontbrekende belangrijke knoppen.
`;

  if (existingIssue) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues/${existingIssue.number}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        body: JSON.stringify({
          title: `🚨 Website monitoring: bezoekersprobleem op ${visitorProblems.length} pagina(s)`,
          body
        })
      }
    );

    if (!response.ok) {
      console.log("Issue update mislukt:", response.status, await response.text());
    } else {
      console.log("Bestaande monitoring issue bijgewerkt met @mention.");
    }

    return;
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({
      title: `🚨 Website monitoring: bezoekersprobleem op ${visitorProblems.length} pagina(s)`,
      body
    })
  });

  if (!response.ok) {
    console.log("Issue aanmaken mislukt:", response.status, await response.text());
  } else {
    console.log("Nieuwe bezoekersprobleem issue aangemaakt met @mention.");
  }
}

function normalizePathFromUrl(pageUrl, baseUrl) {
  try {
    const url = new URL(pageUrl);
    const base = new URL(baseUrl);

    if (url.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) {
      return null;
    }

    return url.pathname || "/";
  } catch {
    return null;
  }
}

function isUsefulPage(url) {
  const lower = String(url).toLowerCase();

  const blockedParts = [
    "/wp-content/",
    "/wp-includes/",
    "/wp-json/",
    "/feed/",
    "/comments/",
    "/tag/",
    "/category/",
    "/author/",
    "/portfolio-category/",
    "/project-category/",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".svg",
    ".pdf",
    ".zip",
    ".xml"
  ];

  return !blockedParts.some(part => lower.includes(part));
}

async function getSitemapUrls(requestContext, site) {
  const baseUrl = site.url.replace(/\/$/, "");

  const sitemapCandidates = [
    `${baseUrl}/sitemap_index.xml`,
    `${baseUrl}/wp-sitemap.xml`,
    `${baseUrl}/page-sitemap.xml`,
    `${baseUrl}/sitemap.xml`
  ];

  const foundUrls = [];

  async function fetchXml(url) {
    try {
      const response = await requestContext.get(url, {
        timeout: 15000,
        failOnStatusCode: false,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8"
        }
      });

      if (!response.ok()) return "";

      const text = await response.text();

      if (!text.includes("<urlset") && !text.includes("<sitemapindex")) {
        return "";
      }

      return text;
    } catch {
      return "";
    }
  }

  function extractLocs(xml) {
    return [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map(m =>
      m[1].trim().replace(/&amp;/g, "&")
    );
  }

  for (const sitemapUrl of sitemapCandidates) {
    const xml = await fetchXml(sitemapUrl);
    if (!xml) continue;

    const locs = extractLocs(xml);

    const childSitemaps = locs.filter(loc =>
      loc.toLowerCase().includes("sitemap")
    );

    const pageUrls = locs.filter(loc =>
      !loc.toLowerCase().includes("sitemap")
    );

    foundUrls.push(...pageUrls);

    for (const child of childSitemaps.slice(0, 8)) {
      const childXml = await fetchXml(child);
      if (!childXml) continue;
      foundUrls.push(...extractLocs(childXml));
    }

    if (foundUrls.length > 0) break;
  }

  const paths = uniq(
    foundUrls
      .filter(isUsefulPage)
      .map(url => normalizePathFromUrl(url, baseUrl))
      .filter(Boolean)
  );

  const fallbackPages = site.pages || ["/"];
  const maxPages = Number(site.maxPages || 8);

  return uniq(["/", ...(paths.length ? paths : fallbackPages)]).slice(0, maxPages);
}

async function runParallel(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const currentIndex = index++;
      results[currentIndex] = await tasks[currentIndex]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker())
  );

  return results;
}

async function checkPage(browser, contextOptions, site, path) {
  const url = site.url.replace(/\/$/, "") + path;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];

  page.on("console", msg => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  let status = "ok";
  const details = [];
  const screenshotName = `${safeFileName(site.name + "-" + path)}.png`;
  let screenshot = null;

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });

    const httpStatus = response?.status();

    if (!response) {
      status = "error";
      details.push("Geen response ontvangen");
    } else if (httpStatus === 403) {
      status = "warning";
      details.push("403 blokkade door beveiliging. Site werkt waarschijnlijk wel voor normale bezoekers.");
    } else if (httpStatus >= 400) {
      status = "error";
      details.push("HTTP fout: " + httpStatus);
    }

    const html = await page.content();
    const htmlLower = html.toLowerCase();

    if (httpStatus !== 403) {
      for (const text of site.requiredText || []) {
        if (!htmlLower.includes(text.toLowerCase())) {
          status = "error";
          details.push("Tekst ontbreekt: " + text);
        }
      }

      for (const buttonText of site.requiredButtons || []) {
        if (!htmlLower.includes(buttonText.toLowerCase())) {
          status = "error";
          details.push("Knop/tekst ontbreekt: " + buttonText);
        }
      }
    }

    const filteredErrors = errors.filter(e =>
      !e.includes("403") &&
      !e.includes("favicon") &&
      !e.includes("Failed to load resource")
    );

    if (filteredErrors.length > 0) {
      details.push("Console meldingen: " + filteredErrors.slice(0, 3).join(" | "));
    }

    const shouldTakeScreenshot = status !== "ok" || path === "/";

    if (shouldTakeScreenshot) {
      await page.screenshot({
        path: `dashboard/${screenshotName}`,
        fullPage: true
      });

      screenshot = screenshotName;
    }
  } catch (e) {
    status = "error";
    details.push(e.message);

    try {
      await page.screenshot({
        path: `dashboard/${screenshotName}`,
        fullPage: true
      });

      screenshot = screenshotName;
    } catch {
      screenshot = null;
    }
  }

  await page.close();
  await context.close();

  return {
    site: site.name,
    siteUrl: site.url,
    path,
    url,
    status,
    details: details.length ? details : ["Alles lijkt goed"],
    checkedAt: new Date().toLocaleString("nl-NL"),
    screenshot
  };
}

(async () => {
  fs.mkdirSync("dashboard", { recursive: true });

  const browser = await chromium.launch();

  const contextOptions = {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 1200 },
    extraHTTPHeaders: {
      "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8"
    }
  };

  const requestContext = await request.newContext();
  const tasks = [];

  for (const site of config.sites || []) {
    let pages = ["/"];

    try {
      if (site.sitemap) {
        pages = await getSitemapUrls(requestContext, site);
      } else {
        pages = site.pages || ["/"];
      }

      if (!pages || pages.length === 0) {
        pages = ["/"];
      }
    } catch (e) {
      console.log("Sitemap fout bij:", site.name, e.message);
      pages = site.pages || ["/"];
    }

    for (const path of pages) {
      tasks.push(() => checkPage(browser, contextOptions, site, path));
    }
  }

  const results = await runParallel(tasks, CONCURRENCY);

  await requestContext.dispose();
  await browser.close();

  const grouped = {};

  for (const r of results) {
    if (!grouped[r.site]) {
      grouped[r.site] = {
        name: r.site,
        siteUrl: r.siteUrl,
        pages: []
      };
    }

    grouped[r.site].pages.push(r);
  }

  const websites = Object.values(grouped).map(site => {
    const hasError = site.pages.some(p => p.status === "error");
    const hasWarning = site.pages.some(p => p.status === "warning");
    const status = hasError ? "error" : hasWarning ? "warning" : "ok";

    return {
      ...site,
      status,
      ok: site.pages.filter(p => p.status === "ok").length,
      warning: site.pages.filter(p => p.status === "warning").length,
      error: site.pages.filter(p => p.status === "error").length,
      total: site.pages.length,
      lastCheck: site.pages[site.pages.length - 1]?.checkedAt || ""
    };
  });

  const totalPages = results.length;
  const totalWebsites = websites.length;
  const okWebsites = websites.filter(w => w.status === "ok").length;
  const warningWebsites = websites.filter(w => w.status === "warning").length;
  const errorWebsites = websites.filter(w => w.status === "error").length;
  const lastCheck = new Date().toLocaleString("nl-NL");

  await createOrUpdateVisitorIssue(results, websites);

  const websiteRows = websites.map((site, siteIndex) => {
    const pageRows = site.pages.map((p, pageIndex) => {
      const screenshotHtml = p.screenshot
        ? `
          <div class="actions">
            <a class="button-link" href="${esc(p.url)}" target="_blank">Pagina openen</a>
            <a class="button-link secondary-link" href="${esc(p.screenshot)}" target="_blank">Screenshot openen</a>
          </div>
        `
        : `
          <div class="actions">
            <a class="button-link" href="${esc(p.url)}" target="_blank">Pagina openen</a>
            <span class="no-screenshot">Geen screenshot nodig bij OK-pagina</span>
          </div>
        `;

      const previewHtml = p.screenshot
        ? `
          <a href="${esc(p.screenshot)}" target="_blank">
            <img class="screenshot-preview" src="${esc(p.screenshot)}" loading="lazy" alt="Screenshot ${esc(p.site)}">
          </a>
        `
        : `<div class="no-preview">Geen screenshot beschikbaar</div>`;

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
          <td>${esc(p.checkedAt)}</td>
          <td class="num">
            <button class="secondary" type="button" onclick="togglePageDetails('${siteIndex}-${pageIndex}')">Details</button>
          </td>
        </tr>

        <tr id="page-details-${siteIndex}-${pageIndex}" class="page-detail-row page-of-${siteIndex}" style="display:none">
          <td colspan="5">
            <div class="detail-box">
              <div>
                <label>Pagina controle</label>
                <div class="hint">
                  ${p.details.map(d => `<div>• ${esc(d)}</div>`).join("")}
                </div>
                ${screenshotHtml}
              </div>
              <div>
                <label>Screenshot</label>
                ${previewHtml}
              </div>
            </div>
          </td>
        </tr>
      `;
    }).join("");

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
          <span class="tag">${site.total} pagina’s</span>
        </td>
        <td>${esc(site.lastCheck)}</td>
        <td class="num">
          <button type="button" onclick="toggleSitePages(${siteIndex})">Pagina’s openen</button>
        </td>
      </tr>
      ${pageRows}
    `;
  }).join("");

  const problemRows = websites
    .filter(w => w.status !== "ok")
    .map(w => `
      <div class="status-row">
        <div>
          <strong>${esc(w.name)}</strong>
          <div class="muted">${w.error} errors · ${w.warning} warnings · ${w.total} pagina’s</div>
        </div>
        <span class="${w.status === "error" ? "danger" : "warning"}">${esc(w.status)}</span>
      </div>
    `).join("");

  fs.writeFileSync("dashboard/index.html", `
<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HJ Online Website Monitoring</title>
<style>
:root{--bg:#f7fbff;--card:#fff;--text:#111827;--muted:#667085;--line:#e5eef7;--accent:#43bff2;--accent-dark:#1598d0;--accent-soft:#eaf8ff;--shadow:0 18px 45px rgba(17,24,39,.08);--radius:22px;--success:#067647;--success-soft:#e7f8e7;--warning:#b54708;--warning-soft:#fff5cc;--danger:#b42318;--danger-soft:#ffdede}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
header{padding:32px 28px;background:linear-gradient(135deg,#fff 0%,#eaf8ff 55%,#d7f2ff 100%)}
header::before{content:"HJ Online";display:inline-flex;margin-bottom:18px;padding:9px 14px;border-radius:999px;background:#fff;color:var(--accent-dark);font-weight:800;box-shadow:0 8px 22px rgba(21,152,208,.16)}
header h1{margin:0 0 8px;font-size:34px;letter-spacing:-.04em}
header p{margin:0;opacity:.78;max-width:960px;line-height:1.55}
main{padding:24px;max-width:1700px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px}
.grid{display:grid;grid-template-columns:repeat(5,minmax(150px,1fr));gap:16px;margin-bottom:18px}
.kpi-title{color:var(--muted);font-size:13px;font-weight:800}
.kpi-value{font-size:28px;font-weight:900;margin-top:8px}
.kpi-sub{color:var(--muted);font-size:12px;margin-top:6px}
.management{display:grid;grid-template-columns:1.1fr .9fr;gap:16px;margin-bottom:18px}
.status-row{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:10px 0}
.status-row:last-child{border-bottom:0}
.positive{color:var(--success);font-weight:800}
.warning{color:var(--warning);font-weight:800}
.danger{color:var(--danger);font-weight:800}
.muted{color:var(--muted);font-size:13px;margin-top:4px}
.hint{color:var(--muted);font-size:13px;line-height:1.5}
.toolbar{display:grid;grid-template-columns:1fr 210px 210px;gap:12px;margin-bottom:12px}
input,select{width:100%;border:1px solid var(--line);border-radius:14px;padding:12px 14px;background:#fff;color:var(--text);outline:none}
button,.button-link{border:0;border-radius:999px;padding:10px 16px;background:var(--accent);color:#fff;font-weight:800;cursor:pointer;box-shadow:0 10px 22px rgba(67,191,242,.28);text-decoration:none;display:inline-flex}
button:hover,.button-link:hover{background:var(--accent-dark)}
button.secondary,.secondary-link{background:var(--accent-soft);color:var(--accent-dark);box-shadow:none}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;align-items:center}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.num{text-align:right;white-space:nowrap}
.customer{font-weight:800}
tr:hover td{background:var(--accent-soft)}
.badge,.tag{display:inline-flex;border-radius:999px;padding:5px 10px;font-weight:900;font-size:12px;text-transform:uppercase;margin:2px}
.badge-ok,.tag.positive{background:var(--success-soft);color:var(--success)}
.badge-warning,.tag.warning{background:var(--warning-soft);color:var(--warning)}
.badge-error,.tag.danger{background:var(--danger-soft);color:var(--danger)}
.tag{background:var(--accent-soft);color:var(--accent-dark)}
.website-row.error td{background:#fffafa}
.website-row.warning td{background:#fffdf5}
.page-row td{background:#fff;font-size:13px}
.page-indent{padding-left:26px;border-left:4px solid var(--accent-soft)}
.page-detail-row td{background:#fff!important}
.detail-box{display:grid;grid-template-columns:1fr 320px;gap:18px;padding:18px;border:1px solid var(--line);border-radius:18px;background:#fff}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:800;text-transform:uppercase;letter-spacing:.03em}
.screenshot-preview{width:100%;max-height:260px;object-fit:cover;border:1px solid var(--line);border-radius:16px;background:#fff}
.no-screenshot,.no-preview{display:flex;align-items:center;justify-content:center;border:1px dashed var(--line);border-radius:16px;background:#fff;color:var(--muted);font-size:13px;padding:18px;min-height:72px}
.no-preview{min-height:180px}
.table-wrap{overflow:auto}
.empty{padding:36px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:16px;background:#fff;display:none}
@media(max-width:1100px){.grid,.management,.toolbar,.detail-box{grid-template-columns:1fr}main{padding:14px}}
</style>
</head>
<body>
<header>
  <h1>Website Monitoring Dashboard</h1>
  <p>Automatische controle van WordPress- en WooCommerce-websites. Pagina’s worden automatisch uit de sitemap gehaald wanneer sitemap: true aanstaat.</p>
</header>

<main>
  <section class="grid">
    <div class="card"><div class="kpi-title">Websites</div><div class="kpi-value">${totalWebsites}</div><div class="kpi-sub">Unieke websites</div></div>
    <div class="card"><div class="kpi-title">Pagina checks</div><div class="kpi-value">${totalPages}</div><div class="kpi-sub">Uit sitemap + homepage</div></div>
    <div class="card"><div class="kpi-title">OK websites</div><div class="kpi-value positive">${okWebsites}</div><div class="kpi-sub">Alles groen</div></div>
    <div class="card"><div class="kpi-title">Warnings</div><div class="kpi-value warning">${warningWebsites}</div><div class="kpi-sub">Aandacht nodig</div></div>
    <div class="card"><div class="kpi-title">Errors</div><div class="kpi-value danger">${errorWebsites}</div><div class="kpi-sub">Direct controleren</div></div>
  </section>

  <section class="management">
    <div class="card">
      <h3>Managementsamenvatting</h3>
      <div class="status-row"><strong>Laatste controle</strong><span>${esc(lastCheck)}</span></div>
      <div class="status-row"><strong>Algemene status</strong><span class="${errorWebsites ? "danger" : warningWebsites ? "warning" : "positive"}">${errorWebsites ? "Errors gevonden" : warningWebsites ? "Warnings gevonden" : "Alles lijkt goed"}</span></div>
      <div class="status-row"><strong>Structuur</strong><span>${totalWebsites} websites · ${totalPages} pagina’s</span></div>
    </div>

    <div class="card">
      <h3>Controle & aandachtspunten</h3>
      <p class="hint">Klik op “Pagina’s openen” om per website de sitemap-pagina’s te bekijken.</p>
      ${problemRows || `<div class="status-row"><strong>Geen aandachtspunten</strong><span class="positive">Alle websites zijn groen</span></div>`}
    </div>
  </section>

  <section class="card">
    <h3>Websites</h3>
    <p class="hint">Eerst zie je websites. Klap een website uit voor gevonden pagina’s, details en screenshots.</p>

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
            <th>Pagina’s</th>
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
  const pageRows = document.querySelectorAll(".page-of-" + siteIndex);
  const first = pageRows[0];
  if (!first) return;

  const shouldOpen = first.style.display === "none";

  pageRows.forEach(row => {
    if (row.classList.contains("page-detail-row")) {
      row.style.display = "none";
    } else {
      row.style.display = shouldOpen ? "table-row" : "none";
    }
  });
}

function togglePageDetails(id) {
  const row = document.getElementById("page-details-" + id);
  if (!row) return;
  row.style.display = row.style.display === "none" ? "table-row" : "none";
}

function filterRows() {
  const q = document.getElementById("searchInput").value.toLowerCase();
  const status = document.getElementById("statusFilter").value;
  const websiteRows = document.querySelectorAll(".website-row");
  let visible = 0;

  websiteRows.forEach(row => {
    const matchesSearch =
      row.dataset.site.includes(q) ||
      row.innerText.toLowerCase().includes(q);

    const matchesStatus = !status || row.dataset.status === status;
    const show = matchesSearch && matchesStatus;

    row.style.display = show ? "table-row" : "none";

    const siteIndex = row.dataset.index;
    document.querySelectorAll(".page-of-" + siteIndex).forEach(pageRow => {
      pageRow.style.display = "none";
    });

    if (show) visible++;
  });

  document.getElementById("emptyState").style.display = visible ? "none" : "block";
}

function sortRows() {
  const mode = document.getElementById("sortFilter").value;
  const tbody = document.getElementById("tableBody");
  const websiteRows = Array.from(tbody.querySelectorAll(".website-row"));
  const statusRank = { error: 0, warning: 1, ok: 2 };

  websiteRows.sort((a, b) => {
    if (mode === "status") {
      return statusRank[a.dataset.status] - statusRank[b.dataset.status];
    }
    if (mode === "site") {
      return a.dataset.site.localeCompare(b.dataset.site);
    }
    return Number(a.dataset.index) - Number(b.dataset.index);
  });

  websiteRows.forEach(row => {
    const siteIndex = row.dataset.index;
    const relatedPages = Array.from(document.querySelectorAll(".page-of-" + siteIndex));

    tbody.appendChild(row);
    relatedPages.forEach(p => {
      p.style.display = "none";
      tbody.appendChild(p);
    });
  });

  filterRows();
}
</script>
</body>
</html>
`);
})();
