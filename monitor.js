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

  const browserContextOptions = {
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

      const context = await browser.newContext(browserContextOptions);
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
          details.push("403: beveiliging blokkeert monitoring (site werkt waarschijnlijk wel)");
        } else if (httpStatus >= 400) {
          status = "error";
          details.push("HTTP fout: " + httpStatus);
        }

        const html = await page.content();
        const htmlLower = html.toLowerCase();

        // Alleen tekst check doen als geen 403
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
              details.push("Belangrijke knop/tekst ontbreekt: " + buttonText);
            }
          }
        }

        const filteredErrors = errors.filter(
          e =>
            !e.includes("403") &&
            !e.includes("ERR_NAME_NOT_RESOLVED") &&
            !e.includes("favicon") &&
            !e.includes("Failed to load resource")
        );

        if (filteredErrors.length > 0) {
          details.push(
            "Console meldingen: " + filteredErrors.slice(0, 3).join(" | ")
          );
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

  const rows = results
    .map(
      r => `
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
  `
    )
    .join("");

  fs.writeFileSync(
    "dashboard/index.html",
    `
<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<title>Website Monitoring</title>
<style>
body { font-family: Arial; padding: 30px; background: #f4f4f4; }
table { width: 100%; border-collapse: collapse; background: white; }
th, td { padding: 12px; border-bottom: 1px solid #ddd; }
.ok { background: #e7f8e7; }
.warning { background: #fff5cc; }
.error { background: #ffdede; }
img { margin-top: 8px; border-radius: 6px; }
</style>
</head>
<body>
<h1>Website Monitoring Dashboard</h1>
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
`
  );
})();
