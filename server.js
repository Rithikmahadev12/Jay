const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// Public SearXNG instances with JSON API — tried in order until one works
const SEARX_INSTANCES = [
  "https://searx.be",
  "https://paulgo.io",
  "https://search.mdosch.de",
  "https://searxng.site",
  "https://search.bus-hit.me",
];

async function fetchFromSearx(query, page) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    pageno: page,
    language: "en",
    engines: "google,bing,duckduckgo",
  });

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json, text/javascript, */*",
    "Accept-Language": "en-US,en;q=0.9",
  };

  for (const instance of SEARX_INSTANCES) {
    try {
      const res = await axios.get(`${instance}/search?${params}`, {
        headers,
        timeout: 7000,
      });

      if (res.data && Array.isArray(res.data.results)) {
        return res.data.results;
      }
    } catch (err) {
      console.warn(`Instance ${instance} failed: ${err.message}`);
      // try next
    }
  }

  throw new Error("All search instances failed");
}

app.get("/search", async (req, res) => {
  const query = (req.query.q || "").trim();
  const page = parseInt(req.query.p) || 1;

  if (!query) return res.json({ results: [], query: "" });

  try {
    const raw = await fetchFromSearx(query, page);

    const results = raw
      .filter((r) => r.url && r.title)
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content || "",
        displayUrl: (() => {
          try {
            const u = new URL(r.url);
            return u.hostname + (u.pathname !== "/" ? u.pathname : "");
          } catch {
            return r.url;
          }
        })(),
      }));

    res.json({ results, query, page });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed. Please try again in a moment." });
  }
});

app.listen(PORT, () => console.log(`Jay's Search running on port ${PORT}`));
