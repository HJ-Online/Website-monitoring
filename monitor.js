const { chromium } = require("playwright");
const fs = require("fs");
const yaml = require("js-yaml");

const config = yaml.load(fs.readFileSync("sites.yml", "utf8"));

function safeFileName(text) {
  return text
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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

  const results = [];

  for (const site of config.sites) {
    for (const path of site.pages || ["/"]) {
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

      try {
        const response = await page.goto(url, {
          waitUntil: "networkidle",
          timeout: 30000
        });

        const httpStatus = response?.status();

        if (!response) {
          status = "error";
          details.push("Geen response ontvangen");
        } else if (httpStatus === 403) {
          status = "warning";
          details.push("403 blokkade (beveiliging) - site werkt waarschijnlijk wel");
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
              details.push("Knop ontbreekt: " + buttonText);
            }
          }
        }

        const filteredErrors = errors.filter(e =>
          !e.includes("403") &&
          !e.includes("favicon") &&
          !e.includes("Failed to load resource")
        );

        if (filteredErrors.length > 0) {
          details.push("Console: " + filteredErrors.slice(0, 2).join(" | "));
        }

        await page.screenshot({
          path: `dashboard/${screenshotName}`,
          fullPage: true
        });

      } catch (e) {
        status = "error";
        details.push(e.message);
      }

      results.push({
        site: site.name,
        url,
        status,
        details: details.join("<br>") || "Alles lijkt goed",
        checkedAt: new Date().toLocaleString("nl-NL"),
        screenshot: screenshotName
      });

      await page.close();
      await context.close();
    }
  }

  await browser.close();

  const total = results.length;
  const ok = results.filter(r => r.status === "ok").length;
  const warning = results.filter(r => r.status === "warning").length;
  const error = results.filter(r => r.status === "error").length;

  const rows = results.map(r => `
    <tr class="${r.status}">
      <td>
        <strong>${r.site}</strong><br>
        <a href="${r.screenshot}" target="_blank">
          <img src="${r.screenshot}" width="220">
        </a>
      </td>
      <td><a href="${r.url}" target="_blank">${r.url}</a></td>
      <td><strong>${r.status}</strong></td>
      <td>${r.details}</td>
      <td>${r.checkedAt}</td>
    </tr>
  `).join("");

  fs.writeFileSync("dashboard/index.html", `
<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<title>Website Monitoring</title>
<style>
body { font-family: Arial; background: #f4f7fb; padding: 30px; }
h1 { margin-bottom: 20px; }

.kpis { display: flex; gap: 20px; margin-bottom: 20px; }
.kpi { background: white; padding: 20px; border-radius: 12px; flex: 1; box-shadow: 0 5px 20px rgba(0,0,0,0.05); }
.kpi h2 { margin: 0; font-size: 28px; }
.kpi p { margin: 0; color: #666; }

table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; }
th, td { padding: 12px; border-bottom: 1px solid #eee; text-align: left; }

.ok { background: #e7f8e7; }
.warning { background: #fff5cc; }
.error { background: #ffdede; }

img { margin-top: 8px; border-radius: 8px; border: 1px solid #ddd; }
a { color: #0073aa; }
</style>
</head>
<body>

<h1>Website Monitoring Dashboard</h1>

<div class="kpis">
  <div class="kpi"><h2>${total}</h2><p>Checks</p></div>
  <div class="kpi"><h2>${ok}</h2><p>OK</p></div>
  <div class="kpi"><h2>${warning}</h2><p>Warnings</p></div>
  <div class="kpi"><h2>${error}</h2><p>Errors</p></div>
</div>

<table>
<tr>
<th>Website</th>
<th>URL</th>
<th>Status</th>
<th>Details</th>
<th>Laatste check</th>
</tr>
${rows}
</table>

</body>
</html>
`);
})();
