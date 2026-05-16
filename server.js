const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/search", async (req, res) => {
  const query = req.query.q;
  const page = parseInt(req.query.p) || 1;

  if (!query) return res.json({ results: [], query: "" });

  try {
    const params = new URLSearchParams({ q: query, b: (page - 1) * 10 });
    const response = await axios.get(
      `https://html.duckduckgo.com/html/?${params}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml",
        },
        timeout: 8000,
      }
    );

    const $ = cheerio.load(response.data);
    const results = [];

    $(".result").each((_, el) => {
      const titleEl = $(el).find(".result__a");
      const snippetEl = $(el).find(".result__snippet");
      const urlEl = $(el).find(".result__url");

      const title = titleEl.text().trim();
      const snippet = snippetEl.text().trim();
      const displayUrl = urlEl.text().trim();
      const href = titleEl.attr("href");

      if (!title || !href) return;

      // DDG wraps real URL in a redirect — extract it
      let url = href;
      try {
        const parsed = new URL("https://duckduckgo.com" + href);
        const uddg = parsed.searchParams.get("uddg");
        if (uddg) url = decodeURIComponent(uddg);
      } catch (_) {}

      if (url.startsWith("http")) {
        results.push({ title, snippet, url, displayUrl });
      }
    });

    res.json({ results, query, page });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ error: "Search failed. Try again." });
  }
});

app.listen(PORT, () => console.log(`Jay's Search running on port ${PORT}`));
