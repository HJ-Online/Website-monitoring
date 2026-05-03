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

function esc(value) {
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
        path,
        url,
        status,
        details: details.length ? details : ["Alles lijkt goed"],
        checkedAt: new Date().toLocaleString("nl-NL"),
        screenshot: screenshotName
      });

      await page.close();
      await context.close();
    }
  }

  await browser.close();

  const total = results.length;
  const uniqueSites = new Set(results.map(r => r.site)).size;
  const ok = results.filter(r => r.status === "ok").length;
  const warning = results.filter(r => r.status === "warning").length;
  const error = results.filter(r => r.status === "error").length;
  const lastCheck = new Date().toLocaleString("nl-NL");
  const successRate = total ? Math.round((ok / total) * 100) : 0;

  const problemRows = results
    .filter(r => r.status !== "ok")
    .map(r => `
      <div class="status-row">
        <div>
          <strong>${esc(r.site)}</strong>
          <div class="muted">${esc(r.url)}</div>
        </div>
        <span class="${r.status === "error" ? "danger" : "warning"}">${esc(r.status)}</span>
      </div>
    `).join("");

  const rows = results.map((r, index) => `
    <tr class="${esc(r.status)}" data-status="${esc(r.status)}" data-site="${esc(r.site.toLowerCase())}">
      <td class="customer">
        ${esc(r.site)}
        <div class="muted">${esc(r.path)}</div>
      </td>
      <td>
        <a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a>
      </td>
      <td>
        <span class="badge badge-${esc(r.status)}">${esc(r.status)}</span>
      </td>
      <td>${esc(r.checkedAt)}</td>
      <td class="num">
        <button class="secondary" type="button" onclick="toggleDetails(${index})">Details openen</button>
      </td>
    </tr>
    <tr id="details-${index}" class="detail-row" style="display:none">
      <td colspan="5">
        <div class="detail-box">
          <div>
            <label>Controle details</label>
            <div class="hint">${r.details.map(d => `<div>• ${esc(d)}</div>`).join("")}</div>
            <div class="actions">
              <a class="button-link" href="${esc(r.url)}" target="_blank">Website openen</a>
              <a class="button-link secondary-link" href="${esc(r.screenshot)}" target="_blank">Screenshot openen</a>
            </div>
          </div>
          <div>
            <label>Screenshot preview</label>
            <a href="${esc(r.screenshot)}" target="_blank">
              <img class="screenshot-preview" src="${esc(r.screenshot)}" loading="lazy" alt="Screenshot ${esc(r.site)}">
            </a>
          </div>
        </div>
      </td>
    </tr>
  `).join("");

  fs.writeFileSync("dashboard/index.html", `
<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HJ Online Website Monitoring</title>
<style>
:root{
  --bg:#f7fbff;
  --card:#fff;
  --text:#111827;
  --muted:#667085;
  --line:#e5eef7;
  --accent:#43bff2;
  --accent-dark:#1598d0;
  --accent-soft:#eaf8ff;
  --shadow:0 18px 45px rgba(17,24,39,.08);
  --radius:22px;
  --success:#067647;
  --success-soft:#e7f8e7;
  --warning:#b54708;
  --warning-soft:#fff5cc;
  --danger:#b42318;
  --danger-soft:#ffdede;
}
*{box-sizing:border-box}
body{
  margin:0;
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background:var(--bg);
  color:var(--text);
}
header{
  padding:32px 28px;
  background:linear-gradient(135deg,#fff 0%,#eaf8ff 55%,#d7f2ff 100%);
}
header::before{
  content:"HJ Online";
  display:inline-flex;
  margin-bottom:18px;
  padding:9px 14px;
  border-radius:999px;
  background:#fff;
  color:var(--accent-dark);
  font-weight:800;
  box-shadow:0 8px 22px rgba(21,152,208,.16);
}
header h1{
  margin:0 0 8px;
  font-size:34px;
  letter-spacing:-.04em;
}
header p{
  margin:0;
  opacity:.78;
  max-width:960px;
  line-height:1.55;
}
main{
  padding:24px;
  max-width:1700px;
  margin:0 auto;
}
.card,.panel{
  background:var(--card);
  border:1px solid var(--line);
  border-radius:var(--radius);
  box-shadow:var(--shadow);
}
.card{padding:18px}
.grid{
  display:grid;
  grid-template-columns:repeat(5,minmax(150px,1fr));
  gap:16px;
  margin-bottom:18px;
}
.kpi-title{
  color:var(--muted);
  font-size:13px;
  font-weight:800;
}
.kpi-value{
  font-size:28px;
  font-weight:900;
  margin-top:8px;
}
.kpi-sub{
  color:var(--muted);
  font-size:12px;
  margin-top:6px;
}
.management{
  display:grid;
  grid-template-columns:1.1fr .9fr;
  gap:16px;
  margin-bottom:18px;
}
.status-row{
  display:flex;
  justify-content:space-between;
  gap:12px;
  border-bottom:1px solid var(--line);
  padding:10px 0;
}
.status-row:last-child{border-bottom:0}
.status-row strong{font-size:14px}
.positive{color:var(--success);font-weight:800}
.warning{color:var(--warning);font-weight:800}
.danger{color:var(--danger);font-weight:800}
.muted{
  color:var(--muted);
  font-size:13px;
}
.hint{
  color:var(--muted);
  font-size:13px;
  line-height:1.5;
}
.toolbar{
  display:grid;
  grid-template-columns:1fr 210px 210px;
  gap:12px;
  margin-bottom:12px;
}
input,select{
  width:100%;
  border:1px solid var(--line);
  border-radius:14px;
  padding:12px 14px;
  background:#fff;
  color:var(--text);
  outline:none;
}
input:focus,select:focus{
  border-color:var(--accent);
  box-shadow:0 0 0 4px rgba(67,191,242,.18);
}
button,.button-link{
  border:0;
  border-radius:999px;
  padding:10px 16px;
  background:var(--accent);
  color:#fff;
  font-weight:800;
  cursor:pointer;
  box-shadow:0 10px 22px rgba(67,191,242,.28);
  text-decoration:none;
  display:inline-flex;
}
button:hover,.button-link:hover{background:var(--accent-dark)}
button.secondary,.secondary-link{
  background:var(--accent-soft);
  color:var(--accent-dark);
  box-shadow:none;
}
.actions{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
  margin-top:12px;
}
table{
  width:100%;
  border-collapse:collapse;
  font-size:14px;
}
th,td{
  padding:12px 14px;
  border-bottom:1px solid var(--line);
  text-align:left;
  vertical-align:top;
}
th{
  color:var(--muted);
  font-size:12px;
  text-transform:uppercase;
  letter-spacing:.04em;
}
.num{text-align:right;white-space:nowrap}
.customer{font-weight:800}
tr:hover td{background:var(--accent-soft)}
.badge{
  display:inline-flex;
  border-radius:999px;
  padding:5px 10px;
  font-weight:900;
  font-size:12px;
  text-transform:uppercase;
}
.badge-ok{background:var(--success-soft);color:var(--success)}
.badge-warning{background:var(--warning-soft);color:var(--warning)}
.badge-error{background:var(--danger-soft);color:var(--danger)}
tr.error td{background:#fffafa}
tr.warning td{background:#fffdf5}
.detail-row td{background:#fff!important}
.detail-box{
  display:grid;
  grid-template-columns:1fr 320px;
  gap:18px;
  padding:18px;
  border:1px solid var(--line);
  border-radius:18px;
  background:#fff;
}
label{
  display:block;
  font-size:12px;
  color:var(--muted);
  margin-bottom:6px;
  font-weight:800;
  text-transform:uppercase;
  letter-spacing:.03em;
}
.screenshot-preview{
  width:100%;
  max-height:260px;
  object-fit:cover;
  border:1px solid var(--line);
  border-radius:16px;
  background:#fff;
}
.table-wrap{overflow:auto}
.empty{
  padding:36px;
  text-align:center;
  color:var(--muted);
  border:1px dashed var(--line);
  border-radius:16px;
  background:#fff;
  display:none;
}
@media(max-width:1100px){
  .grid,.management,.toolbar,.detail-box{grid-template-columns:1fr}
  main{padding:14px}
}
</style>
</head>
<body>
<header>
  <h1>Website Monitoring Dashboard</h1>
  <p>Automatische controle van WordPress- en WooCommerce-websites. Controleert HTTP-status, verplichte teksten, belangrijke knoppen, browsermeldingen en screenshots per pagina.</p>
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
      <div class="kpi-value positive">${ok}</div>
      <div class="kpi-sub">Geen problemen</div>
    </div>
    <div class="card">
      <div class="kpi-title">Warnings</div>
      <div class="kpi-value warning">${warning}</div>
      <div class="kpi-sub">Aandacht nodig</div>
    </div>
    <div class="card">
      <div class="kpi-title">Errors</div>
      <div class="kpi-value danger">${error}</div>
      <div class="kpi-sub">Direct controleren</div>
    </div>
  </section>

  <section class="management">
    <div class="card">
      <h3>Managementsamenvatting</h3>
      <div class="status-row">
        <strong>Laatste controle</strong>
        <span>${esc(lastCheck)}</span>
      </div>
      <div class="status-row">
        <strong>Succespercentage</strong>
        <span class="${error ? "danger" : "positive"}">${successRate}%</span>
      </div>
      <div class="status-row">
        <strong>Algemene status</strong>
        <span class="${error ? "danger" : warning ? "warning" : "positive"}">${error ? "Errors gevonden" : warning ? "Warnings gevonden" : "Alles lijkt goed"}</span>
      </div>
    </div>

    <div class="card">
      <h3>Controle & aandachtspunten</h3>
      <p class="hint">Errors zijn echte problemen. Warnings zijn vaak beveiligingsblokkades zoals 403 vanuit GitHub Actions.</p>
      ${problemRows || `<div class="status-row"><strong>Geen aandachtspunten</strong><span class="positive">Alle checks zijn groen</span></div>`}
    </div>
  </section>

  <section class="card">
    <h3>Website checks</h3>
    <p class="hint">Gebruik zoeken en filters. Screenshots worden pas zichtbaar wanneer je details opent.</p>

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
            <th>URL</th>
            <th>Status</th>
            <th>Laatste check</th>
            <th class="num">Details</th>
          </tr>
        </thead>
        <tbody id="tableBody">
          ${rows}
        </tbody>
      </table>
    </div>
    <div id="emptyState" class="empty">Geen resultaten gevonden.</div>
  </section>
</main>

<script>
function toggleDetails(index) {
  const row = document.getElementById("details-" + index);
  if (!row) return;
  row.style.display = row.style.display === "none" ? "table-row" : "none";
}

function filterRows() {
  const q = document.getElementById("searchInput").value.toLowerCase();
  const status = document.getElementById("statusFilter").value;
  const rows = document.querySelectorAll("#tableBody tr[data-status]");
  let visible = 0;

  rows.forEach(row => {
    const detail = row.nextElementSibling;
    const matchesSearch =
      row.dataset.site.includes(q) ||
      row.innerText.toLowerCase().includes(q);

    const matchesStatus = !status || row.dataset.status === status;
    const show = matchesSearch && matchesStatus;

    row.style.display = show ? "table-row" : "none";
    if (detail && detail.classList.contains("detail-row")) {
      detail.style.display = "none";
    }
    if (show) visible++;
  });

  document.getElementById("emptyState").style.display = visible ? "none" : "block";
}

function sortRows() {
  const mode = document.getElementById("sortFilter").value;
  const tbody = document.getElementById("tableBody");
  const mainRows = Array.from(tbody.querySelectorAll("tr[data-status]"));

  const statusRank = { error: 0, warning: 1, ok: 2 };

  mainRows.sort((a, b) => {
    if (mode === "status") {
      return statusRank[a.dataset.status] - statusRank[b.dataset.status];
    }
    if (mode === "site") {
      return a.dataset.site.localeCompare(b.dataset.site);
    }
    return 0;
  });

  mainRows.forEach(row => {
    const detail = row.nextElementSibling;
    tbody.appendChild(row);
    if (detail && detail.classList.contains("detail-row")) {
      detail.style.display = "none";
      tbody.appendChild(detail);
    }
  });

  filterRows();
}
</script>
</body>
</html>
`);
})();
