const { chromium, request } = require("playwright");
const fs = require("fs");
const yaml = require("js-yaml");
const crypto = require("crypto");

const config = yaml.load(fs.readFileSync("sites.yml", "utf8"));
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const GITHUB_USERNAME = "HJ-Online";

function safeFileName(text) {
  return text.toLowerCase().replace(/https?:\/\//g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

function uniq(arr) {
  return [...new Set(arr)];
}

/* =========================
   MENU DETECTIE (NIEUW)
========================= */
async function getMenuUrls(browser, contextOptions, site) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const baseUrl = site.url.replace(/\/$/, "");

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2000);

    const links = await page.evaluate(() => {
      const selectors = [
        "header a","nav a",".menu a",".elementor-nav-menu a",".navbar a"
      ];
      return Array.from(document.querySelectorAll(selectors.join(",")))
        .map(a => a.href)
        .filter(Boolean);
    });

    const paths = uniq(
      links
        .map(link => {
          try {
            const url = new URL(link);
            return url.pathname.endsWith("/") ? url.pathname : url.pathname + "/";
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    );

    return ["/", ...paths].slice(0, site.maxPages || 8);
  } catch {
    return site.pages || ["/"];
  } finally {
    await page.close();
    await context.close();
  }
}

/* =========================
   PAGINA CHECK
========================= */
async function checkPage(browser, contextOptions, site, path) {
  const url = site.url.replace(/\/$/, "") + path;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  let status = "ok";
  const details = [];

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });

    const httpStatus = response?.status();

    if (httpStatus === 403) {
      // 🔥 BELANGRIJK: Wordfence fix
      status = "ok";
      details.push("GitHub-monitor geblokkeerd door Wordfence/beveiliging (403). Genegeerd omdat normale bezoekers de site kunnen zien.");
      return {
        site: site.name,
        siteUrl: site.url,
        path,
        url,
        status,
        details,
        checkedAt: new Date().toLocaleString("nl-NL")
      };
    }

    if (!response) {
      status = "error";
      details.push("Geen response");
    } else if (httpStatus >= 400) {
      status = "error";
      details.push("HTTP fout: " + httpStatus);
    }

  } catch (e) {
    status = "error";
    details.push(e.message);
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
    checkedAt: new Date().toLocaleString("nl-NL")
  };
}

/* =========================
   PARALLEL RUNNER
========================= */
async function runParallel(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

/* =========================
   MAIN
========================= */
(async () => {
  fs.mkdirSync("dashboard", { recursive: true });

  const browser = await chromium.launch();

  const contextOptions = {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    viewport: { width: 390, height: 844 },
    isMobile: true
  };

  const tasks = [];

  for (const site of config.sites || []) {
    let pages = ["/"];

    if (site.sitemap === "menu") {
      pages = await getMenuUrls(browser, contextOptions, site);
    } else {
      pages = site.pages || ["/"];
    }

    for (const path of pages) {
      tasks.push(() => checkPage(browser, contextOptions, site, path));
    }
  }

  const results = await runParallel(tasks, CONCURRENCY);
  await browser.close();

  /* =========================
     GROEPEREN
  ========================= */
  const grouped = {};
  for (const r of results) {
    if (!grouped[r.site]) {
      grouped[r.site] = { name: r.site, siteUrl: r.siteUrl, pages: [] };
    }
    grouped[r.site].pages.push(r);
  }

  const websites = Object.values(grouped).map(site => {
    const hasError = site.pages.some(p => p.status === "error");
    return {
      ...site,
      status: hasError ? "error" : "ok",
      ok: site.pages.filter(p => p.status === "ok").length,
      error: site.pages.filter(p => p.status === "error").length,
      total: site.pages.length,
      lastCheck: site.pages[0]?.checkedAt
    };
  });

  /* =========================
     DASHBOARD (JOUW ORIGINEEL)
  ========================= */

  fs.writeFileSync("dashboard/index.html", `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>HJ Monitoring</title>
<style>
body{font-family:sans-serif;background:#f5f7fa}
.card{background:#fff;padding:20px;margin:20px;border-radius:10px}
.badge{padding:5px 10px;border-radius:10px}
.ok{background:#d4edda}
.error{background:#f8d7da}
</style>
</head>
<body>

<h1>Website Monitoring</h1>

${websites.map(site => `
<div class="card">
  <h2>${site.name}</h2>
  <div>Status: <span class="badge ${site.status}">${site.status}</span></div>
  <div>${site.total} pagina’s</div>

  <ul>
    ${site.pages.map(p => `
      <li>
        ${p.path} → ${p.status}
        <br>
        <small>${p.details.join(", ")}</small>
      </li>
    `).join("")}
  </ul>
</div>
`).join("")}

</body>
</html>
`);
})();
