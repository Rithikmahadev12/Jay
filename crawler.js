const axios = require("axios");
const cheerio = require("cheerio");
const db = require("./db");

let crawling = false;
let crawlStats = { crawled: 0, failed: 0, queued: 0, running: false };

function isCrawling() { return crawling; }
function getStats() { return { ...crawlStats, queued: db.prepare("SELECT COUNT(*) as c FROM crawl_queue").get().c }; }

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = "";
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u.href;
  } catch { return null; }
}

function extractContent($) {
  // Remove noise elements
  $("script, style, noscript, nav, footer, header, aside, iframe, [role='navigation'], [role='banner'], [aria-hidden='true']").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return text.slice(0, 8000);
}

async function crawlPage(url, depth) {
  const res = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 4,
    headers: {
      "User-Agent": "JaysBot/1.0 (personal search engine crawler)",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    validateStatus: (s) => s < 400,
  });

  const ct = res.headers["content-type"] || "";
  if (!ct.includes("text/html")) return [];

  const $ = cheerio.load(res.data);

  const title =
    $("meta[property='og:title']").attr("content") ||
    $("title").text().trim() ||
    $("h1").first().text().trim() ||
    url;

  const description =
    $("meta[name='description']").attr("content") ||
    $("meta[property='og:description']").attr("content") ||
    $("p").first().text().trim().slice(0, 300) ||
    "";

  const content = extractContent($);
  const domain = getDomain(url);

  // Upsert into pages table
  const existing = db.prepare("SELECT id FROM pages WHERE url = ?").get(url);
  if (existing) {
    db.prepare(`
      UPDATE pages SET title=?, description=?, content=?, domain=?, last_crawled=CURRENT_TIMESTAMP
      WHERE url=?
    `).run(title.slice(0, 300), description.slice(0, 500), content, domain, url);
  } else {
    db.prepare(`
      INSERT INTO pages (url, title, description, content, domain)
      VALUES (?, ?, ?, ?, ?)
    `).run(url, title.slice(0, 300), description.slice(0, 500), content, domain);
  }

  // Collect outbound links
  if (depth >= 2) return [];
  const links = new Set();
  $("a[href]").each((_, el) => {
    const norm = normalizeUrl($(el).attr("href"), url);
    if (norm) links.add(norm);
  });
  return [...links];
}

async function startCrawl({ maxPages = 100, sameDomain = false } = {}) {
  if (crawling) return;
  crawling = true;
  crawlStats = { crawled: 0, failed: 0, running: true };

  // Seed the queue from seeds table
  const seeds = db.prepare("SELECT url FROM seeds").all();
  for (const s of seeds) {
    db.prepare("INSERT OR IGNORE INTO crawl_queue (url, depth) VALUES (?, 0)").run(s.url);
  }

  const addToQueue = db.prepare("INSERT OR IGNORE INTO crawl_queue (url, depth) VALUES (?, ?)");

  while (crawlStats.crawled + crawlStats.failed < maxPages) {
    const next = db.prepare("SELECT * FROM crawl_queue ORDER BY depth ASC, id ASC LIMIT 1").get();
    if (!next) break;

    db.prepare("DELETE FROM crawl_queue WHERE id = ?").run(next.id);

    // Skip recently crawled pages (within 12 hours)
    const existing = db.prepare("SELECT last_crawled FROM pages WHERE url = ?").get(next.url);
    if (existing) {
      const age = Date.now() - new Date(existing.last_crawled).getTime();
      if (age < 12 * 60 * 60 * 1000) { crawlStats.crawled++; continue; }
    }

    try {
      console.log(`[Crawl ${crawlStats.crawled + 1}] ${next.url}`);
      const links = await crawlPage(next.url, next.depth);
      crawlStats.crawled++;

      // Add links to queue (optionally restrict to same domain)
      const baseDomain = getDomain(next.url);
      for (const link of links.slice(0, 30)) {
        if (sameDomain && getDomain(link) !== baseDomain) continue;
        addToQueue.run(link, next.depth + 1);
      }
    } catch (err) {
      console.warn(`[Fail] ${next.url} — ${err.message}`);
      crawlStats.failed++;
    }

    // Be polite — wait between requests
    await new Promise((r) => setTimeout(r, 500));
  }

  crawling = false;
  crawlStats.running = false;
  console.log(`Crawl done. Crawled: ${crawlStats.crawled}, Failed: ${crawlStats.failed}`);
}

function stopCrawl() { crawling = false; }

module.exports = { startCrawl, stopCrawl, isCrawling, getStats };
