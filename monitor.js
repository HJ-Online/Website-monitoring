const { chromium, request } = require("playwright");
const fs = require("fs");
const yaml = require("js-yaml");
const crypto = require("crypto");

const config = yaml.load(fs.readFileSync("sites.yml", "utf8"));
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const GITHUB_USERNAME = "HJ-Online";

/* =========================
   🔥 NIEUW: REALISTISCHE FINGERPRINT
========================= */
const contextOptions = {
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",

  viewport: { width: 1366, height: 768 },

  locale: "nl-NL",
  timezoneId: "Europe/Amsterdam",

  geolocation: { longitude: 5.1214, latitude: 52.0907 },
  permissions: ["geolocation"],

  colorScheme: "light",

  extraHTTPHeaders: {
    "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8,en-US;q=0.7",
    "Upgrade-Insecure-Requests": "1"
  }
};

/* ========================= */

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

/* =========================
   🔥 NIEUW: STEALTH APPLY
========================= */
async function applyStealth(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });

    Object.defineProperty(navigator, 'languages', {
      get: () => ['nl-NL', 'nl', 'en-US', 'en']
    });

    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5]
    });

    window.chrome = {
      runtime: {}
    };
  });
}
/* ========================= */

function isVisitorVisibleProblem(result) {
  if (result.status !== "error") return false;

  const details = result.details.join(" ").toLowerCase();

  const ignoredSignals = [
    "403",
    "bot",
    "cdn",
    "console meldingen",
    "favicon",
    "failed to load resource",
    "github-monitor geblokkeerd"
  ];

  const visitorSignals = [
    "geen response",
    "timeout",
    "net::err",
    "http fout",
    "tekst ontbreekt",
    "knop/tekst ontbreekt",
    "css bestand laadt niet",
    "javascript bestand laadt niet",
    "pagina lijkt niet goed gestyled",
    "te weinig zichtbare tekst",
    "te weinig afbeeldingen",
    "belangrijke selector ontbreekt",
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

/* =========================
   🔥 AANGEPAST: context + stealth
========================= */
async function getMenuUrls(browser, site) {
  const context = await browser.newContext(contextOptions);
  await applyStealth(context);
  const page = await context.newPage();

  const baseUrl = site.url.replace(/\/$/, "");

  try {
    await page.goto(baseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });

    await page.waitForTimeout(2000);

    const links = await page.evaluate(() => {
      const selectors = [
        "header a",
        "nav a",
        ".menu a",
        ".main-menu a",
        ".primary-menu a",
        ".elementor-nav-menu a",
        ".elementor-location-header a",
        ".site-header a",
        ".navbar a"
      ];

      const anchors = Array.from(document.querySelectorAll(selectors.join(",")));

      return anchors.map(a => a.href).filter(Boolean);
    });

    return uniq(
      links.map(link => {
        try {
          return new URL(link).pathname;
        } catch {
          return null;
        }
      }).filter(Boolean)
    );
  } catch {
    return ["/"];
  } finally {
    await context.close();
  }
}

/* =========================
   🔥 AANGEPAST: checkPage
========================= */
async function checkPage(browser, site, path) {
  const url = site.url.replace(/\/$/, "") + path;

  const context = await browser.newContext(contextOptions);
  await applyStealth(context);
  const page = await context.newPage();

  const details = [];
  let status = "ok";

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });

    const httpStatus = response?.status();

    if (!response) {
      status = "error";
      details.push("Geen response");
    } else if (httpStatus >= 400 && httpStatus !== 403) {
      status = "error";
      details.push("HTTP fout: " + httpStatus);
    }

  } catch (e) {
    status = "error";
    details.push(e.message);
  }

  await context.close();

  return {
    site: site.name,
    path,
    url,
    status,
    details,
    checkedAt: new Date().toLocaleString("nl-NL")
  };
}

/* ========================= */

(async () => {
  fs.mkdirSync("dashboard", { recursive: true });

  const browser = await chromium.launch({
    headless: true
  });

  const requestContext = await request.newContext();

  const tasks = [];

  for (const site of config.sites || []) {
    const pages = site.pages || ["/"];

    for (const path of pages) {
      tasks.push(() => checkPage(browser, site, path));
    }
  }

  const results = await Promise.all(tasks.map(fn => fn()));

  await browser.close();

  fs.writeFileSync("dashboard/results.json", JSON.stringify(results, null, 2));

})();
