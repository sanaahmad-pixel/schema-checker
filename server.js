const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = 3000;

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Shared helpers ────────────────────────────────────────────────────────

function validateUrl(raw) {
  if (!raw || typeof raw !== "string") throw new Error("A URL is required.");
  const parsed = new URL(raw); // throws on invalid
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("URL must use http or https.");
  }
  return parsed;
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    headers: FETCH_HEADERS,
    validateStatus: (s) => s < 500,
  });
  if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
  return response.data;
}

function friendlyFetchError(err) {
  if (err.code === "ECONNABORTED" || err.message.includes("timeout")) return "Request timed out after 15 seconds.";
  if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") return "Couldn't reach that host. Check the URL and try again.";
  return `Fetch failed: ${err.message}`;
}

function extractSchemas($) {
  const schemas = [];
  const parseErrors = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html()?.trim() || "";
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        schemas.push({ type: item["@type"] || "Unknown", json: item, raw });
      }
    } catch (err) {
      parseErrors.push({ raw, error: err.message });
    }
  });
  return { schemas, parseErrors };
}

function extractMeta($) {
  return {
    pageTitle: $("title").first().text().trim() || null,
    metaDescription:
      $('meta[name="description"]').attr("content")?.trim() ||
      $('meta[property="og:description"]').attr("content")?.trim() ||
      null,
  };
}

// ── POST /api/scan — single page ──────────────────────────────────────────

app.post("/api/scan", async (req, res) => {
  let parsedUrl;
  try {
    parsedUrl = validateUrl(req.body?.url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  let html;
  try {
    html = await fetchHtml(parsedUrl.href);
  } catch (err) {
    return res.status(200).json({ error: friendlyFetchError(err) });
  }

  const $ = cheerio.load(html);
  const { pageTitle, metaDescription } = extractMeta($);
  const { schemas, parseErrors } = extractSchemas($);

  return res.json({ url: parsedUrl.href, pageTitle, metaDescription, schemas, parseErrors, totalSchemas: schemas.length });
});

// ── Site-scan helpers ─────────────────────────────────────────────────────

const CATEGORY_RULES = [
  {
    key: "contact",
    label: "Contact Page",
    test: (pathname, text) =>
      /\/(contact|contact-us|contactus|get-in-touch|reach-us)(\/|$)/i.test(pathname) ||
      /\bcontact\b/i.test(text),
  },
  {
    key: "blog-post",
    label: "Blog Post",
    test: (pathname) =>
      /\/(blog|news|journal|articles?|post|posts|insights?)\/[^/]+\/?$/i.test(pathname),
  },
  {
    key: "tour-detail",
    label: "Tour / Service Page",
    test: (pathname) =>
      /\/(tours?|trips?|experiences?|safaris?|services?|packages?)\/[^/]+\/?$/i.test(pathname),
  },
  {
    key: "category",
    label: "Category / Destination Listing",
    test: (pathname) =>
      /\/(destinations?|categories|collections|regions?)(\/[^/]+)?\/?$/i.test(pathname) ||
      /^\/tours?\/?$/i.test(pathname),
  },
  {
    key: "product",
    label: "Product Page",
    test: (pathname) =>
      /\/(products?|p|shop|store)\/[^/]+\/?$/i.test(pathname),
  },
];

function discoverPages(html, baseUrl) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const seen = new Set([base.href]);
  const candidates = {};

  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href")?.trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("tel:") || raw.startsWith("javascript:")) return;

    let resolved;
    try { resolved = new URL(raw, base); } catch { return; }

    if (resolved.origin !== base.origin) return;
    resolved.hash = "";
    const clean = resolved.href;
    if (seen.has(clean)) return;
    seen.add(clean);

    const pathname = resolved.pathname;
    const linkText = $(el).text().trim();

    for (const rule of CATEGORY_RULES) {
      if (!candidates[rule.key] && rule.test(pathname, linkText)) {
        candidates[rule.key] = clean;
        break;
      }
    }
  });

  return candidates;
}

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { results[i] = await tasks[i](); }
      catch (e) { results[i] = { error: e.message }; }
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  if (workerCount === 0) return results;
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// ── POST /api/scan-site — multi-page ─────────────────────────────────────

app.post("/api/scan-site", async (req, res) => {
  let parsedUrl;
  try {
    parsedUrl = validateUrl(req.body?.url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  let homepageHtml;
  try {
    homepageHtml = await fetchHtml(parsedUrl.href);
  } catch (err) {
    return res.status(200).json({ error: `Couldn't fetch homepage: ${friendlyFetchError(err)}` });
  }

  const candidateMap = discoverPages(homepageHtml, parsedUrl.href);

  const ALL_CATEGORIES = [
    { key: "homepage", label: "Homepage" },
    ...CATEGORY_RULES.map((r) => ({ key: r.key, label: r.label })),
  ];

  const toScan = ALL_CATEGORIES.filter((c) => c.key === "homepage" || candidateMap[c.key]).map((c) => ({
    ...c,
    url: c.key === "homepage" ? parsedUrl.href : candidateMap[c.key],
  }));

  const categoriesNotFound = ALL_CATEGORIES.filter((c) => c.key !== "homepage" && !candidateMap[c.key]).map((c) => c.label);

  const tasks = toScan.map((page) => async () => {
    try {
      const html = page.key === "homepage" ? homepageHtml : await fetchHtml(page.url);
      const $ = cheerio.load(html);
      const { pageTitle, metaDescription } = extractMeta($);
      const { schemas, parseErrors } = extractSchemas($);
      return { category: page.label, url: page.url, pageTitle, metaDescription, schemas, parseErrors };
    } catch (err) {
      return { category: page.label, url: page.url, error: friendlyFetchError(err), schemas: [], parseErrors: [] };
    }
  });

  const discoveredPages = await runWithConcurrency(tasks, 5);

  const totalSchemasFound = discoveredPages.reduce((a, p) => a + (p.schemas?.length || 0), 0);
  const totalParseErrors = discoveredPages.reduce((a, p) => a + (p.parseErrors?.length || 0), 0);

  return res.json({ siteUrl: parsedUrl.href, discoveredPages, categoriesNotFound, totalSchemasFound, totalParseErrors });
});

// ── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Schema Checker running at http://localhost:${PORT}`);
});
