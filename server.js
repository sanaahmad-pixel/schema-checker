const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.post("/api/scan", async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "A URL is required." });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: "URL must use http or https." });
    }
  } catch {
    return res.status(400).json({ error: "Invalid URL. Please include https://." });
  }

  let html;
  try {
    const response = await axios.get(parsedUrl.href, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      validateStatus: (status) => status < 500,
    });

    if (response.status >= 400) {
      return res.status(200).json({
        error: `The page returned HTTP ${response.status}. It may require login or doesn't exist.`,
      });
    }

    html = response.data;
  } catch (err) {
    if (err.code === "ECONNABORTED" || err.message.includes("timeout")) {
      return res.status(200).json({ error: "Request timed out after 15 seconds." });
    }
    if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
      return res.status(200).json({ error: "Couldn't reach that host. Check the URL and try again." });
    }
    return res.status(200).json({ error: `Fetch failed: ${err.message}` });
  }

  const $ = cheerio.load(html);

  const pageTitle = $("title").first().text().trim() || null;
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    null;

  const schemas = [];
  const parseErrors = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html()?.trim() || "";
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      // Handle both single objects and arrays at the top level
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        schemas.push({
          type: item["@type"] || "Unknown",
          json: item,
          raw,
        });
      }
    } catch (err) {
      parseErrors.push({ raw, error: err.message });
    }
  });

  return res.json({
    url: parsedUrl.href,
    pageTitle,
    metaDescription,
    schemas,
    parseErrors,
    totalSchemas: schemas.length,
  });
});

app.listen(PORT, () => {
  console.log(`Schema Checker running at http://localhost:${PORT}`);
});
