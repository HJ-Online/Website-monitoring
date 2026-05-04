const { chromium } = require("playwright");
const fs = require("fs");
const yaml = require("js-yaml");

const config = yaml.load(fs.readFileSync("sites.yml", "utf8"));
const CONCURRENCY = 5;

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

async function checkPage(browser, contextOptions, site, path) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

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
      details.push("Beveiliging blokkeert monitoring (Wordfence 403)");
    }

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

(async () => {
  fs.mkdirSync("dashboard", { recursive: true });

  const browser = await chromium.launch();

  const contextOptions = {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "nl-NL",
    timezoneId: "Europe/Amsterdam"
  };

  const tasks = [];

  for (const site of config.sites) {
    for (const path of site.pages) {
      tasks.push(() => checkPage(browser, contextOptions, site, path));
    }
  }

  const results = await runParallel(tasks, CONCURRENCY);
  await browser.close();

  fs.writeFileSync("dashboard/results.json", JSON.stringify(results, null, 2));

  // GROUP PER SITE
  const grouped = {};
  results.forEach(r => {
    if (!grouped[r.site]) grouped[r.site] = [];
    grouped[r.site].push(r);
  });

  const html = `
<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<title>Website Monitoring</title>

<style>
body {
  font-family: Arial;
  background: #f5f7fa;
  padding: 20px;
}

h1 { margin-bottom: 30px; }

.card {
  background: white;
  border-radius: 10px;
  padding: 15px;
  margin-bottom: 15px;
  box-shadow: 0 2px 5px rgba(0,0,0,0.05);
}

.badge {
  padding: 5px 10px;
  border-radius: 20px;
  font-size: 12px;
  margin-right: 5px;
}

.ok { background: #e6f7ec; color: green; }
.warning { background: #fff4e5; color: orange; }
.error { background: #fdecea; color: red; }

.page {
  margin-left: 20px;
  padding: 8px 0;
  border-top: 1px solid #eee;
}

button {
  background: #3498db;
  color: white;
  border: none;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
}
</style>

<script>
function toggle(id) {
  const el = document.getElementById(id);
  el.style.display = el.style.display === "none" ? "block" : "none";
}

function filter(status) {
  document.querySelectorAll(".card").forEach(c => {
    if (status === "all" || c.dataset.status === status) {
      c.style.display = "block";
    } else {
      c.style.display = "none";
    }
  });
}
</script>

</head>
<body>

<h1>Website Monitoring</h1>

<button onclick="filter('all')">Alles</button>
<button onclick="filter('ok')">OK</button>
<button onclick="filter('warning')">Warnings</button>
<button onclick="filter('error')">Errors</button>

<br><br>

${Object.keys(grouped).map((site, i) => {
  const pages = grouped[site];
  const errors = pages.filter(p => p.status === "error").length;
  const warnings = pages.filter(p => p.status === "warning").length;

  let status = "ok";
  if (errors > 0) status = "error";
  else if (warnings > 0) status = "warning";

  return `
<div class="card" data-status="${status}">
  <strong>${site}</strong><br>
  <span class="badge ${status}">${status.toUpperCase()}</span>
  <span class="badge ok">${pages.filter(p => p.status === "ok").length} OK</span>
  <span class="badge warning">${warnings} warnings</span>
  <span class="badge error">${errors} errors</span>

  <br><br>
  <button onclick="toggle('site-${i}')">Pagina’s</button>

  <div id="site-${i}" style="display:none;">
    ${pages.map(p => `
      <div class="page">
        <strong>${p.path}</strong><br>
        <a href="${p.url}" target="_blank">${p.url}</a><br>
        <span class="badge ${p.status}">${p.status}</span><br>
        ${p.details.join("<br>")}
        ${p.screenshot ? `<br><img src="${p.screenshot}" width="250">` : ""}
      </div>
    `).join("")}
  </div>
</div>
`;
}).join("")}

</body>
</html>
`;

  fs.writeFileSync("dashboard/index.html", html);

  console.log("Dashboard klaar");
})();
