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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[m]));
}

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
      const screenshotName = `${safeFileName(site.name + "-" + path)}.png`;

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
        const htmlLower = html.toLowerCase();

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

        const filteredErrors = errors.filter(e =>
          !e.includes("403") &&
          !e.includes("ERR_NAME_NOT_RESOLVED") &&
          !e.includes("favicon") &&
          !e.includes("Failed to load resource")
        );

        if (filteredErrors.length > 0) {
          details.push("Console meldingen: " + filteredErrors.slice(0, 3).join(" | "));
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
        path,
        status,
        details: details.length ? details : ["Alles lijkt goed"],
        checkedAt: new Date().toLocaleString("nl-NL"),
        screenshot: screenshotName
      });

      await page.close();
    }
  }

  await browser.close();

  const total = results.length;
  const okCount = results.filter(r => r.status === "ok").length;
  const errorCount = results.filter(r => r.status === "error").length;
  const warningCount = results.filter(r => r.status === "warning").length;
  const uniqueSites = new Set(results.map(r => r.site)).size;
  const lastCheck = new Date().toLocaleString("nl-NL");

  const rows = results.map(r => `
    <tr class="${r.status}">
      <td>
        <strong>${escapeHtml(r.site)}</strong>
        <div class="muted">${escapeHtml(r.path)}</div>
        <a href="${escapeHtml(r.screenshot)}" target="_blank">
          <img src="${escapeHtml(r.screenshot)}" alt="Screenshot ${escapeHtml(r.site)}">
        </a>
      </td>
      <td>
        <a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.url)}</a>
      </td>
      <td>
        <span class="badge badge-${r.status}">${escapeHtml(r.status)}</span>
      </td>
      <td>
        ${r.details.map(d => `<div>${escapeHtml(d)}</div>`).join("")}
      </td>
      <td>${escapeHtml(r.checkedAt)}</td>
    </tr>
  `).join("");

  const problemRows = results
    .filter(r => r.status !== "ok")
    .map(r => `
      <div class="status-row">
        <div>
          <strong>${escapeHtml(r.site)}</strong>
          <div class="muted">${escapeHtml(r.url)}</div>
        </div>
        <span class="danger">${escapeHtml(r.details.join(" | "))}</span>
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
    :root {
      --bg: #f7fbff;
      --card: #ffffff;
      --text: #111827;
      --muted: #667085;
      --line: #e5eef7;
      --accent: #43bff2;
      --accent-dark: #1598d0;
      --accent-soft: #eaf8ff;
      --success-bg: #e7f8e7;
      --success: #067647;
      --warning-bg: #fff5cc;
      --warning: #b54708;
      --error-bg: #ffdede;
      --danger: #b42318;
      --shadow: 0 18px 45px rgba(17,24,39,.08);
      --radius: 22px;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }

    header {
      padding: 32px 28px;
      background: linear-gradient(135deg, #fff 0%, #eaf8ff 55%, #d7f2ff 100%);
    }

    header::before {
      content: "HJ Online";
      display: inline-flex;
      margin-bottom: 18px;
      padding: 9px 14px;
      border-radius: 999px;
      background: #fff;
      color: var(--accent-dark);
      font-weight: 800;
      box-shadow: 0 8px 22px rgba(21,152,208,.16);
    }

    header h1 {
      margin: 0 0 8px;
      font-size: 34px;
      letter-spacing: -.04em;
    }

    header p {
      margin: 0;
      opacity: .78;
      max-width: 960px;
      line-height: 1.55;
    }

    main {
      padding: 24px;
      max-width: 1700px;
      margin: 0 auto;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(160px, 1fr));
      gap: 16px;
      margin-bottom: 18px;
    }

    .card, .panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }

    .card {
      padding: 18px;
    }

    .kpi-title {
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }

    .kpi-value {
      font-size: 28px;
      font-weight: 900;
      margin-top: 8px;
    }

    .kpi-sub {
      color: var(--muted);
      font-size: 12px;
      margin-top: 6px;
    }

    .management {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 18px;
    }

    .status-row {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      border-bottom: 1px solid var(--line);
      padding: 12px 0;
    }

    .status-row:last-child {
      border-bottom: 0;
    }

    .muted {
      color: var(--muted);
      font-size: 13px;
      margin-top: 4px;
    }

    .positive { color: var(--success); font-weight: 800; }
    .warning-text { color: var(--warning); font-weight: 800; }
    .danger { color: var(--danger); font-weight: 800; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      background: white;
    }

    th, td {
      padding: 14px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }

    tr:hover td {
      background: var(--accent-soft);
    }

    img {
      display: block;
      width: 240px;
      max-height: 170px;
      object-fit: cover;
      border: 1px solid var(--line);
      border-radius: 14px;
      margin-top: 10px;
      background: #fff;
    }

    a {
      color: var(--accent-dark);
      font-weight: 700;
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 6px 11px;
      font-weight: 900;
      font-size: 12px;
      text-transform: uppercase;
    }

    .badge-ok {
      background: var(--success-bg);
      color: var(--success);
    }

    .badge-warning {
      background: var(--warning-bg);
      color: var(--warning);
    }

    .badge-error {
      background: var(--error-bg);
      color: var(--danger);
    }

    tr.ok {
      background: #fff;
    }

    tr.warning {
      background: var(--warning-bg);
    }

    tr.error {
      background: var(--error-bg);
    }

    .table-card {
      overflow: auto;
      padding: 0;
    }

    .table-card h2 {
      padding: 18px 18px 0;
      margin: 0;
    }

    .table-card p {
      padding: 0 18px;
      color: var(--muted);
    }

    @media(max-width: 1100px) {
      .grid, .management {
        grid-template-columns: 1fr;
      }

      main {
        padding: 14px;
      }

      img {
        width: 180px;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>Website Monitoring Dashboard</h1>
    <p>Automatische controle van WordPress- en WooCommerce-websites. Het dashboard controleert statuscodes, verplichte teksten, belangrijke knoppen, browsermeldingen en maakt screenshots per pagina.</p>
  </header>

  <main>
    <section class="grid">
      <div class="card">
        <div class="kpi-title">Websites</div>
        <div class="kpi-value">${uniqueSites}</div>
        <div class="kpi-sub">Unieke websites</div>
      </div>

      <div class="card">
        <div class="kpi-title">Pagina checks</div>
        <div class="kpi-value">${total}</div>
        <div class="kpi-sub">Totaal gecontroleerd</div>
      </div>

      <div class="card">
        <div class="kpi-title">OK</div>
        <div class="kpi-value positive">${okCount}</div>
        <div class="kpi-sub">Geen problemen gevonden</div>
      </div>

      <div class="card">
        <div class="kpi-title">Warnings</div>
        <div class="kpi-value warning-text">${warningCount}</div>
        <div class="kpi-sub">Aandacht nodig</div>
      </div>

      <div class="card">
        <div class="kpi-title">Errors</div>
        <div class="kpi-value danger">${errorCount}</div>
        <div class="kpi-sub">Direct controleren</div>
      </div>
    </section>

    <section class="management">
      <div class="card">
        <h2>Samenvatting</h2>
        <div class="status-row">
          <strong>Laatste controle</strong>
          <span>${escapeHtml(lastCheck)}</span>
        </div>
        <div class="status-row">
          <strong>Algemene status</strong>
          <span class="${errorCount > 0 ? "danger" : "positive"}">${errorCount > 0 ? "Problemen gevonden" : "Alles lijkt goed"}</span>
        </div>
        <div class="status-row">
          <strong>Succespercentage</strong>
          <span class="positive">${total ? Math.round((okCount / total) * 100) : 0}%</span>
        </div>
      </div>

      <div class="card">
        <h2>Aandachtspunten</h2>
        ${
          problemRows ||
          `<div class="status-row"><strong>Geen problemen</strong><span class="positive">Alle checks zijn groen</span></div>`
        }
      </div>
    </section>

    <section class="card table-card">
      <h2>Alle website checks</h2>
      <p>Klik op een screenshot om de volledige afbeelding te openen.</p>
      <table>
        <thead>
          <tr>
            <th>Website + screenshot</th>
            <th>URL</th>
            <th>Status</th>
            <th>Details</th>
            <th>Laatste check</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>
  `);
})();
