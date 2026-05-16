const axios = require("axios");
const cheerio = require("cheerio");
const db = require("./db");

let crawling = false;
let crawlStats = { crawled: 0, failed: 0, running: false };

function isCrawling() { return crawling; }
function getStats() {
  return {
    ...crawlStats,
    queued: db.prepare("SELECT COUNT(*) as c FROM crawl_queue").get().c,
  };
}

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

// Detect if a query string looks like a URL
function detectUrl(query) {
  const q = query.trim();
  // Already has protocol
  if (/^https?:\/\//i.test(q)) {
    try { new URL(q); return q; } catch { return null; }
  }
  // Looks like a domain: has a dot, no spaces, reasonable TLD
  if (!q.includes(" ") && /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(q)) {
    try { new URL("https://" + q); return "https://" + q; } catch { return null; }
  }
  return null;
}

function extractContent($) {
  $("script,style,noscript,nav,footer,header,aside,iframe,[role='navigation'],[role='banner'],[aria-hidden='true']").remove();
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
}

async function fetchPage(url) {
  const res = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 4,
    headers: {
      "User-Agent": "JaysBot/1.0",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    validateStatus: (s) => s < 400,
  });

  const ct = res.headers["content-type"] || "";
  if (!ct.includes("text/html")) return null;

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

  // Collect links
  const links = new Set();
  $("a[href]").each((_, el) => {
    const norm = normalizeUrl($(el).attr("href"), url);
    if (norm) links.add(norm);
  });

  return { title, description, content, domain, links: [...links] };
}

function savePage(url, data) {
  const existing = db.prepare("SELECT id FROM pages WHERE url = ?").get(url);
  if (existing) {
    db.prepare(
      "UPDATE pages SET title=?,description=?,content=?,domain=?,last_crawled=CURRENT_TIMESTAMP WHERE url=?"
    ).run(data.title.slice(0, 300), data.description.slice(0, 500), data.content, data.domain, url);
  } else {
    db.prepare(
      "INSERT INTO pages (url,title,description,content,domain) VALUES (?,?,?,?,?)"
    ).run(url, data.title.slice(0, 300), data.description.slice(0, 500), data.content, data.domain);
  }
}

// On-demand crawl: crawl a URL + its immediate links, used during search
async function crawlOnDemand(startUrl, maxPages = 25) {
  const queue = [{ url: startUrl, depth: 0 }];
  const visited = new Set();
  let count = 0;

  while (queue.length > 0 && count < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    // Skip if crawled recently (within 6 hours)
    const existing = db.prepare("SELECT last_crawled FROM pages WHERE url=?").get(url);
    if (existing) {
      const age = Date.now() - new Date(existing.last_crawled).getTime();
      if (age < 6 * 60 * 60 * 1000) { count++; continue; }
    }

    try {
      const data = await fetchPage(url);
      if (!data) continue;
      savePage(url, data);
      count++;

      if (depth < 1) {
        // Only follow links on the same domain for on-demand crawls
        const baseDomain = getDomain(startUrl);
        for (const link of data.links.slice(0, 20)) {
          if (getDomain(link) === baseDomain && !visited.has(link)) {
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      }
    } catch (e) {
      // silently skip failed pages
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  return count;
}

// Background crawl for /admin
async function startCrawl({ maxPages = 100, sameDomain = false } = {}) {
  if (crawling) return;
  crawling = true;
  crawlStats = { crawled: 0, failed: 0, running: true };

  const seeds = db.prepare("SELECT url FROM seeds").all();
  const addQ = db.prepare("INSERT OR IGNORE INTO crawl_queue (url,depth) VALUES (?,?)");
  for (const s of seeds) addQ.run(s.url, 0);

  while (crawlStats.crawled + crawlStats.failed < maxPages) {
    const next = db.prepare("SELECT * FROM crawl_queue ORDER BY depth ASC, id ASC LIMIT 1").get();
    if (!next) break;
    db.prepare("DELETE FROM crawl_queue WHERE id=?").run(next.id);

    const existing = db.prepare("SELECT last_crawled FROM pages WHERE url=?").get(next.url);
    if (existing) {
      const age = Date.now() - new Date(existing.last_crawled).getTime();
      if (age < 12 * 60 * 60 * 1000) { crawlStats.crawled++; continue; }
    }

    try {
      const data = await fetchPage(next.url);
      if (data) {
        savePage(next.url, data);
        if (next.depth < 2) {
          const baseDomain = getDomain(next.url);
          for (const link of data.links.slice(0, 30)) {
            if (sameDomain && getDomain(link) !== baseDomain) continue;
            addQ.run(link, next.depth + 1);
          }
        }
        crawlStats.crawled++;
      }
    } catch { crawlStats.failed++; }

    await new Promise((r) => setTimeout(r, 400));
  }

  crawling = false;
  crawlStats.running = false;
}

function stopCrawl() { crawling = false; }

module.exports = { startCrawl, stopCrawl, isCrawling, getStats, crawlOnDemand, detectUrl };
