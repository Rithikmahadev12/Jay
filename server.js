const express = require("express");
const path = require("path");
const db = require("./db");
const { startCrawl, stopCrawl, isCrawling, getStats, crawlOnDemand, detectUrl } = require("./crawler");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

function searchIndex(query, page = 1, perPage = 10) {
  const offset = (page - 1) * perPage;
  const words = query.trim().split(/\s+/);
  // Build FTS match: every word must appear (AND logic)
  const ftsQuery = words.map(w => w.replace(/[^a-zA-Z0-9]/g, '') + '*').filter(Boolean).join(' AND ');
  try {
    const rows = db.prepare(`
      SELECT p.url, p.title, p.description, p.domain,
             snippet(pages_fts, 2, '<<', '>>', '...', 20) AS snippet,
             rank
      FROM pages_fts
      JOIN pages p ON pages_fts.rowid = p.id
      WHERE pages_fts MATCH ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `).all(ftsQuery, perPage * 3, offset); // fetch more, then filter

    // Filter: at least one word must appear in title or description
    const lower = query.toLowerCase();
    const queryWords = words.map(w => w.toLowerCase()).filter(w => w.length > 1);
    const relevant = rows.filter(r => {
      const haystack = ((r.title || '') + ' ' + (r.description || '')).toLowerCase();
      return queryWords.some(w => haystack.includes(w));
    });

    // Fall back to all rows if filter removed everything (e.g. content-only match is better than nothing)
    return (relevant.length > 0 ? relevant : rows).slice(0, perPage);
  } catch {
    return db.prepare(`
      SELECT url, title, description, domain, '' as snippet
      FROM pages
      WHERE title LIKE ? OR description LIKE ?
      LIMIT ? OFFSET ?
    `).all(`%${query}%`, `%${query}%`, perPage, offset);
  }
}

function formatResults(rows) {
  return rows.map((r) => ({
    title: r.title || r.url,
    url: r.url,
    displayUrl: r.domain || r.url,
    snippet: r.description || r.snippet?.replace(/<<|>>/g, "") || "",
  }));
}

// ── SEARCH ──────────────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  const query = (req.query.q || "").trim();
  const page = Math.max(1, parseInt(req.query.p) || 1);

  if (!query) return res.json({ results: [], query: "", page: 1 });

  // 1. Search existing index
  let rows = searchIndex(query, page);

  // 2. No results? Check if query is a URL and crawl it on demand
  if (rows.length === 0) {
    const url = detectUrl(query);
    if (url) {
      // Tell the client we're crawling
      res.setHeader("X-Crawling", "true");
      try {
        await crawlOnDemand(url, 30);
        rows = searchIndex(query, page);
        // If FTS still finds nothing, search by domain
        if (rows.length === 0) {
          const domain = new URL(url).hostname;
          rows = db.prepare(
            "SELECT url, title, description, domain, '' as snippet FROM pages WHERE domain=? LIMIT 10"
          ).all(domain);
        }
      } catch (e) {
        console.error("On-demand crawl failed:", e.message);
      }
    }
  }

  res.json({
    results: formatResults(rows),
    query,
    page,
    crawled: rows.length > 0 && req.headers["x-crawling"] === "true",
  });
});

// ── ADMIN ────────────────────────────────────────────────────────────────────
app.get("/admin/stats", (req, res) => {
  const pages = db.prepare("SELECT COUNT(*) as c FROM pages").get().c;
  const seeds = db.prepare("SELECT * FROM seeds ORDER BY added DESC").all();
  const recent = db.prepare(
    "SELECT url,title,domain,last_crawled FROM pages ORDER BY last_crawled DESC LIMIT 15"
  ).all();
  res.json({ pages, seeds, recent, crawl: getStats(), crawling: isCrawling() });
});

app.post("/admin/seeds", (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });
  try {
    if (!url.startsWith("http")) url = "https://" + url;
    new URL(url);
    db.prepare("INSERT OR IGNORE INTO seeds (url) VALUES (?)").run(url);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: "Invalid URL" }); }
});

app.delete("/admin/seeds/:id", (req, res) => {
  db.prepare("DELETE FROM seeds WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.post("/admin/crawl/start", (req, res) => {
  if (isCrawling()) return res.json({ ok: false, message: "Already crawling" });
  const maxPages = Math.min(parseInt(req.body.maxPages) || 100, 500);
  const sameDomain = !!req.body.sameDomain;
  startCrawl({ maxPages, sameDomain });
  res.json({ ok: true, message: `Crawling up to ${maxPages} pages…` });
});

app.post("/admin/crawl/stop", (req, res) => {
  stopCrawl();
  res.json({ ok: true });
});

app.delete("/admin/index", (req, res) => {
  db.prepare("DELETE FROM pages").run();
  db.prepare("DELETE FROM crawl_queue").run();
  db.prepare("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')").run();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Jay's Search → http://localhost:${PORT}`));
