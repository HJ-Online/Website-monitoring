const { chromium, request } = require("playwright");
const fs = require("fs");
const yaml = require("js-yaml");
const crypto = require("crypto");

const config = yaml.load(fs.readFileSync("sites.yml", "utf8"));
const CONCURRENCY = 5;

function safeFileName(text) {
  return text.toLowerCase().replace(/https?:\/\//g, "").replace(/[^a-z0-9]+/g, "-");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

function uniq(arr) {
  return [...new Set(arr)];
}

function isVisitorVisibleProblem(r) {
  if (r.status !== "error") return false;

  const text = r.details.join(" ").toLowerCase();

  const ignore = ["403", "favicon", "failed to load resource", "console"];
  if (ignore.some(i => text.includes(i))) return false;

  const visitor = ["http", "timeout", "geen response", "tekst ontbreekt"];
  return visitor.some(v => text.includes(v));
}

function fingerprint(items) {
  return crypto.createHash("sha256")
    .update(items.map(r => r.site + r.path + r.details.join()).join("\n"))
    .digest("hex");
}

async function createOrUpdateIssue(results) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return;

  const problems = results.filter(isVisitorVisibleProblem);
  if (!problems.length) return;

  const hash = fingerprint(problems);

  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const issues = await res.json();
  const existing = issues.find(i => i.title.includes("Website monitoring"));

  const body = `<!-- ${hash} -->

🚨 Bezoekersproblemen gevonden

${problems.map(p => `
### ${p.site} ${p.path}
${p.url}
${p.details.join(" | ")}
`).join("\n")}`;

  if (existing && existing.body.includes(hash)) return;

  if (existing) {
    await fetch(existing.url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ body })
    });
  } else {
    await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: "🚨 Website monitoring probleem",
        body
      })
    });
  }
}

async function runParallel(tasks, limit) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function checkPage(browser, site, path) {
  const context = await browser.newContext();
  const page = await context.newPage();

  let status = "ok";
  const details = [];
  const url = site.url.replace(/\/$/, "") + path;

  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    if (!res) {
      status = "error";
      details.push("geen response");
    } else if (res.status() >= 400 && res.status() !== 403) {
      status = "error";
      details.push("http " + res.status());
    }

    const html = (await page.content()).toLowerCase();

    for (const t of site.requiredText || []) {
      if (!html.includes(t.toLowerCase())) {
        status = "error";
        details.push("tekst ontbreekt: " + t);
      }
    }

    if (status !== "ok" || path === "/") {
      await page.screenshot({
        path: `dashboard/${safeFileName(site.name + path)}.png`,
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
    details
  };
}

(async () => {
  fs.mkdirSync("dashboard", { recursive: true });

  const browser = await chromium.launch();
  const tasks = [];

  for (const site of config.sites || []) {
    const pages = (site.pages || ["/"]).slice(0, site.maxPages || 8);

    for (const path of pages) {
      tasks.push(() => checkPage(browser, site, path));
    }
  }

  const results = await runParallel(tasks, CONCURRENCY);

  await browser.close();

  await createOrUpdateIssue(results);

  fs.writeFileSync("dashboard/index.html", `
    <h1>Monitoring</h1>
    <pre>${JSON.stringify(results, null, 2)}</pre>
  `);
})();
