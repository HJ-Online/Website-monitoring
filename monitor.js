const { chromium } = require("playwright");
const fs = require("fs");
const yaml = require("js-yaml");

const config = yaml.load(fs.readFileSync("sites.yml", "utf8"));

(async () => {
  fs.mkdirSync("dashboard", { recursive: true });

  const browser = await chromium.launch();
  const results = [];

  for (const site of config.sites) {
    for (const path of site.pages || ["/"]) {
      const url = site.url.replace(/\/$/, "") + path;
      const page = await browser.newPage();
      const errors = [];

      page.on("console", msg => {
        if (msg.type() === "error") errors.push(msg.text());
      });

      let status = "ok";
      const details = [];

      try {
        const response = await page.goto(url, {
          waitUntil: "networkidle",
          timeout: 30000
        });

        if (!response || response.status() >= 400) {
          status = "error";
          details.push("HTTP fout: " + response?.status());
        }

        const html = await page.content();

        for (const text of site.requiredText || []) {
          if (!html.includes(text)) {
            status = "error";
            details.push("Tekst ontbreekt: " + text);
          }
        }

        if (errors.length > 0 && status !== "error") {
          status = "warning";
          details.push("Console errors gevonden");
        }

        await page.screenshot({
          path: `dashboard/${site.name.replaceAll(" ", "-")}.png`,
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
        checkedAt: new Date().toLocaleString("nl-NL")
      });

      await page.close();
    }
  }

  await browser.close();

  const rows = results.map(r => `
    <tr class="${r.status}">
      <td>${r.site}</td>
      <td><a href="${r.url}" target="_blank">${r.url}</a></td>
      <td>${r.status}</td>
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
        body { font-family: Arial, sans-serif; padding: 30px; background: #f4f4f4; }
        table { width: 100%; border-collapse: collapse; background: white; }
        th, td { padding: 12px; border-bottom: 1px solid #ddd; text-align: left; }
        .ok { background: #e7f8e7; }
        .warning { background: #fff5cc; }
        .error { background: #ffdede; }
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
  `);
})();
