const { chromium } = require("playwright");
const fs = require("fs");
const yaml = require("js-yaml");

// CONFIG
const config = yaml.load(fs.readFileSync("sites.yml", "utf8"));
const CONCURRENCY = 5;

// HELPERS
function safeFileName(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "-");
}

async function runParallel(tasks, limit) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < tasks.length) {
      const index = i++;
      results[index] = await tasks[index]();
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// PAGE CHECK
async function checkPage(browser, contextOptions, site, path) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // STEALTH
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['nl-NL','nl'] });
  });

  const url = site.url.replace(/\/$/, "") + path;

  let status = "ok";
  let details = [];
  let screenshot = null;

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20000
    });

    await page.waitForTimeout(2000 + Math.random() * 2000);

    const httpStatus = response?.status();

    if (!response) {
      status = "error";
      details.push("Geen response");
    } else if (httpStatus >= 500) {
      status = "error";
      details.push("Server error: " + httpStatus);
    } else if (httpStatus >= 400 && httpStatus !== 403) {
      status = "error";
      details.push("HTTP fout: " + httpStatus);
    }

    let blocked = false;
    if (httpStatus === 403) {
      blocked = true;
      details.push("Wordfence blokkeert monitoring (403) → genegeerd");
    }

    // FRONTEND CHECKS
    if (!blocked) {
      const text = await page.textContent("body") || "";

      if (text.length < (site.minTextLength || 200)) {
        status = "error";
        details.push("Te weinig content zichtbaar");
      }

      const buttons = await page.$$eval("a,button", els => els.length);
      if (buttons < 1) {
        status = "error";
        details.push("Geen knoppen/menu zichtbaar");
      }

      const hasCSS = await page.evaluate(() => {
        return document.styleSheets.length > 0;
      });

      if (!hasCSS) {
        status = "error";
        details.push("CSS niet geladen (layout kapot)");
      }
    }

    // SCREENSHOT
    if (status !== "ok" || path === "/") {
      const name = safeFileName(site.name + path) + ".png";
      await page.screenshot({ path: `dashboard/${name}`, fullPage: true });
      screenshot = name;
    }

  } catch (e) {
    status = "error";
    details.push(e.message);
  }

  await page.close();
  await context.close();

  return {
    site: site.name,
    url,
    path,
    status,
    details,
    screenshot,
    checkedAt: new Date().toLocaleString("nl-NL")
  };
}

// RUN
(async () => {
  fs.mkdirSync("dashboard", { recursive: true });

  const browser = await chromium.launch();

  const contextOptions = {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "nl-NL",
    timezoneId: "Europe/Amsterdam",
    extraHTTPHeaders: {
      "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8"
    }
  };

  const tasks = [];

  for (const site of config.sites) {
    const pages = site.pages || ["/"];

    for (const path of pages) {
      tasks.push(() => checkPage(browser, contextOptions, site, path));
    }
  }

  const results = await runParallel(tasks, CONCURRENCY);

  await browser.close();

  // JSON
  fs.writeFileSync("dashboard/results.json", JSON.stringify(results, null, 2));

  // HTML DASHBOARD (FIX VOOR 404)
  const html = `
<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<title>Website Monitoring</title>
<style>
body { font-family: Arial; padding: 20px; }
.ok { color: green; }
.warning { color: orange; }
.error { color: red; }
.card { border: 1px solid #ddd; padding: 10px; margin-bottom: 10px; }
</style>
</head>
<body>

<h1>Website Monitoring</h1>

${results.map(r => `
<div class="card">
  <strong>${r.site}</strong><br>
  <a href="${r.url}" target="_blank">${r.url}</a><br>
  Status: <span class="${r.status}">${r.status}</span><br>
  ${r.details.join("<br>")}
  ${r.screenshot ? `<br><img src="${r.screenshot}" width="300">` : ""}
</div>
`).join("")}

</body>
</html>
`;

  fs.writeFileSync("dashboard/index.html", html);

  console.log("Monitoring + dashboard klaar");
})();
