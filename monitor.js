const { chromium, request } = require("playwright");
const fs = require("fs");
const yaml = require("js-yaml");

const config = yaml.load(fs.readFileSync("sites.yml", "utf8"));

const CONCURRENCY = 5; // 🔥 hoeveel pagina's tegelijk

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
    ".jpg",".jpeg",".png",".gif",".webp",".svg",".pdf",".zip",".xml"
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
        failOnStatusCode: false
      });

      if (!response.ok()) return "";
      return await response.text();
    } catch {
      return "";
    }
  }

  function extractLocs(xml) {
    return [...xml.matchAll(/<loc>(.*?)<\/loc>/gi)].map(m => m[1]);
  }

  for (const sitemapUrl of sitemapCandidates) {
    const xml = await fetchXml(sitemapUrl);
    if (!xml) continue;

    const locs = extractLocs(xml);

    foundUrls.push(...locs);

    if (foundUrls.length > 0) break;
  }

  const paths = uniq(
    foundUrls
      .filter(isUsefulPage)
      .map(url => normalizePathFromUrl(url, baseUrl))
      .filter(Boolean)
  );

  const maxPages = Number(site.maxPages || 8);

  return uniq(["/", ...paths]).slice(0, maxPages);
}

// 🔥 simpele concurrency runner
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

(async () => {
  fs.mkdirSync("dashboard", { recursive: true });

  const browser = await chromium.launch();
  const requestContext = await request.newContext();

  const contextOptions = {
    userAgent: "Mozilla/5.0",
    viewport: { width: 1440, height: 1200 }
  };

  const tasks = [];

  for (const site of config.sites || []) {
    let pages = ["/"];

    try {
      pages = site.sitemap
        ? await getSitemapUrls(requestContext, site)
        : site.pages || ["/"];
    } catch {
      pages = ["/"];
    }

    for (const path of pages) {
      tasks.push(async () => {
        const url = site.url.replace(/\/$/, "") + path;
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        let status = "ok";
        const details = [];
        const screenshotName = `${safeFileName(site.name + "-" + path)}.png`;

        try {
          const response = await page.goto(url, {
            waitUntil: "domcontentloaded", // 🔥 sneller
            timeout: 20000
          });

          const httpStatus = response?.status();

          if (!response) {
            status = "error";
            details.push("Geen response");
          } else if (httpStatus === 403) {
            status = "warning";
            details.push("403 blokkade");
          } else if (httpStatus >= 400) {
            status = "error";
            details.push("HTTP " + httpStatus);
          }

          const html = await page.content().then(h => h.toLowerCase());

          if (httpStatus !== 403) {
            for (const text of site.requiredText || []) {
              if (!html.includes(text.toLowerCase())) {
                status = "error";
                details.push("Mist tekst: " + text);
              }
            }
          }

          // 🔥 screenshot alleen indien nodig
          if (status !== "ok" || path === "/") {
            await page.screenshot({
              path: `dashboard/${screenshotName}`,
              fullPage: true
            });
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
          details: details.length ? details : ["OK"],
          checkedAt: new Date().toLocaleString("nl-NL"),
          screenshot: (status !== "ok" || path === "/") ? screenshotName : null
        };
      });
    }
  }

  // 🔥 parallel uitvoeren
  const results = (await runParallel(tasks, CONCURRENCY)).flat();

  await browser.close();
  await requestContext.dispose();

  console.log("Klaar:", results.length, "checks");
})();
