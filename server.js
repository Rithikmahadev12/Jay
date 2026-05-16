const express = require("express");
const path = require("path");
const db = require("./db");
const { startCrawl, stopCrawl, isCrawling, getStats } = require("./crawler");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── SEARCH ──────────────────────────────────────────────────────────────────
app.get("/search", (req, res) => {
  const query = (req.query.q || "").trim();
  const page = Math.max(1, parseInt(req.query.p) || 1);
  const perPage = 10;
  const offset = (page - 1) * perPage;

  if (!query) return res.json({ results: [], query: "", page: 1 });

  const total = db.prepare("SELECT COUNT(*) as c FROM pages").get().c;
  if (total === 0) {
    return res.json({
      results: [],
      query,
      page,
      empty: true,
      message: "Your index is empty. Go to /admin to add seeds and start crawling.",
    });
  }

  try {
    // Use FTS5 with snippet highlighting
    const rows = db.prepare(`
      SELECT
        p.url, p.title, p.description, p.domain,
        snippet(pages_fts, 2, '<<', '>>', '...', 20) AS snippet
      FROM pages_fts
      JOIN pages p ON pages_fts.rowid = p.id
      WHERE pages_fts MATCH ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).all(query + "*", perPage, offset); // prefix match: "you" matches "youtube"

    res.json({
      results: rows.map((r) => ({
        title: r.title || r.url,
        url: r.url,
        displayUrl: r.domain || r.url,
        snippet: r.description || r.snippet || "",
      })),
      query,
      page,
    });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed: " + err.message });
  }
});

// ── ADMIN API ────────────────────────────────────────────────────────────────

// Stats
app.get("/admin/stats", (req, res) => {
  const pages = db.prepare("SELECT COUNT(*) as c FROM pages").get().c;
  const seeds = db.prepare("SELECT * FROM seeds ORDER BY added DESC").all();
  const recent = db.prepare(
    "SELECT url, title, domain, last_crawled FROM pages ORDER BY last_crawled DESC LIMIT 15"
  ).all();
  res.json({ pages, seeds, recent, crawl: getStats(), crawling: isCrawling() });
});

// Add seed
app.post("/admin/seeds", (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });
  try {
    if (!url.startsWith("http")) url = "https://" + url;
    new URL(url); // validate
    db.prepare("INSERT OR IGNORE INTO seeds (url) VALUES (?)").run(url);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: "Invalid URL" });
  }
});

// Remove seed
app.delete("/admin/seeds/:id", (req, res) => {
  db.prepare("DELETE FROM seeds WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Start crawl
app.post("/admin/crawl/start", (req, res) => {
  if (isCrawling()) return res.json({ ok: false, message: "Already crawling" });
  const maxPages = Math.min(parseInt(req.body.maxPages) || 100, 500);
  const sameDomain = !!req.body.sameDomain;
  startCrawl({ maxPages, sameDomain });
  res.json({ ok: true, message: `Crawling up to ${maxPages} pages…` });
});

// Stop crawl
app.post("/admin/crawl/stop", (req, res) => {
  stopCrawl();
  res.json({ ok: true });
});

// Clear index
app.delete("/admin/index", (req, res) => {
  db.prepare("DELETE FROM pages").run();
  db.prepare("DELETE FROM crawl_queue").run();
  db.prepare("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')").run();
  res.json({ ok: true });
});

app.listen(PORT, () =>
  console.log(`Jay's Search running → http://localhost:${PORT}`)
);
