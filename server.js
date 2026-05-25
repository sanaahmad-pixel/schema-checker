require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = 3000;

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Playwright singleton ──────────────────────────────────────────────────

let _browser = null;

async function getBrowser() {
  if (!_browser) {
    const { chromium } = require("playwright");
    _browser = await chromium.launch({ headless: true });
  }
  return _browser;
}

// ── Claude client ─────────────────────────────────────────────────────────

let _claude = null;

function getClaudeClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === "your_key_here") return null;
  if (!_claude) _claude = new Anthropic({ apiKey: key });
  return _claude;
}

// ── Shared helpers ────────────────────────────────────────────────────────

function validateUrl(raw) {
  if (!raw || typeof raw !== "string") throw new Error("A URL is required.");
  const parsed = new URL(raw);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("URL must use http or https.");
  }
  return parsed;
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    decompress: true,
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

function parseSchemasFromScripts(scripts) {
  const schemas = [];
  const parseErrors = [];
  for (const raw of scripts) {
    const text = raw?.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        schemas.push({ type: item["@type"] || "Unknown", json: item, raw: text });
      }
    } catch (err) {
      parseErrors.push({ raw: text, error: err.message });
    }
  }
  return { schemas, parseErrors };
}

function extractSchemas($) {
  const scripts = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    scripts.push($(el).html());
  });
  return parseSchemasFromScripts(scripts);
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

async function fetchAndExtractSchemas(url) {
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    return await fetchWithPlaywright(url, err);
  }

  const $ = cheerio.load(html);
  const { pageTitle, metaDescription } = extractMeta($);
  const { schemas, parseErrors } = extractSchemas($);

  if (schemas.length > 0 || parseErrors.length > 0) {
    return { schemas, parseErrors, pageTitle, metaDescription, fetchMethod: "static" };
  }

  console.log(`[Playwright fallback] No schemas found via static fetch for: ${url}`);
  return await fetchWithPlaywright(url, null, { pageTitle, metaDescription });
}

async function fetchWithPlaywright(url, originalError, staticMeta = {}) {
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    if (originalError) throw originalError;
    return { schemas: [], parseErrors: [], pageTitle: staticMeta.pageTitle || null, metaDescription: staticMeta.metaDescription || null, fetchMethod: "static" };
  }

  let page;
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      // non-fatal — proceed with what we have
    }

    const scripts = await page.$$eval(
      'script[type="application/ld+json"]',
      (els) => els.map((el) => el.textContent)
    );

    const pageTitle = await page.title().catch(() => staticMeta.pageTitle || null);
    const metaDescription = await page
      .$eval('meta[name="description"]', (el) => el.getAttribute("content"))
      .catch(() => staticMeta.metaDescription || null);

    await context.close();

    const { schemas, parseErrors } = parseSchemasFromScripts(scripts);
    return { schemas, parseErrors, pageTitle, metaDescription, fetchMethod: "rendered" };
  } catch (err) {
    if (page) await page.context().close().catch(() => {});
    if (originalError) throw originalError;
    throw err;
  }
}

// ── Claude AI analysis ────────────────────────────────────────────────────

const ANALYSIS_SYSTEM_PROMPT = `You are a senior SEO specialist with deep expertise in Schema.org structured data and the travel industry. Analyze web pages against best practices and provide actionable, specific recommendations. Reference Schema.org standard types and their required/recommended fields. Output valid JSON only, no prose around it.`;

async function analyzeWithClaude(pageData) {
  const client = getClaudeClient();
  if (!client) {
    return { error: "Claude API not configured — add ANTHROPIC_API_KEY to .env file." };
  }

  const { url, pageTitle, metaDescription, schemas, parseErrors } = pageData;

  const userMessage = `Analyze this web page's schema markup and provide SEO recommendations.

URL: ${url}
Page Title: ${pageTitle || "(none)"}
Meta Description: ${metaDescription || "(none)"}

Schemas Found (${schemas.length}):
${schemas.length > 0
  ? schemas.map((s, i) => `${i + 1}. @type: ${s.type}\n${JSON.stringify(s.json, null, 2)}`).join("\n\n")
  : "(none)"}

Parse Errors (${parseErrors.length}):
${parseErrors.length > 0
  ? parseErrors.map((e, i) => `${i + 1}. ${e.error}\nRaw: ${e.raw.substring(0, 200)}`).join("\n\n")
  : "(none)"}

Return JSON matching exactly this structure:
{
  "pageType": "string (e.g., 'Tour Detail Page', 'Homepage', 'Contact Page', 'Destination Listing')",
  "pageTypeConfidence": "high|medium|low",
  "existingSchemaAnalysis": [
    {
      "schemaType": "string",
      "status": "valid|has_issues|invalid",
      "issues": ["specific issues"],
      "notes": "additional context"
    }
  ],
  "missingSchemas": [
    {
      "schemaType": "string",
      "priority": "high|medium|low",
      "reason": "why this schema fits this page type",
      "recommendedFields": ["important fields to include"]
    }
  ],
  "overallScore": 0,
  "summary": "one-paragraph executive summary"
}`;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = message.content[0]?.text?.trim() || "";
    // Strip markdown code fences if present
    const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

    try {
      return JSON.parse(jsonText);
    } catch {
      return {
        error: "Claude returned unparseable JSON.",
        pageType: "Unknown",
        pageTypeConfidence: "low",
        existingSchemaAnalysis: [],
        missingSchemas: [],
        overallScore: null,
        summary: text.substring(0, 500),
      };
    }
  } catch (err) {
    if (err.status === 401) return { error: "Claude API key is invalid. Check ANTHROPIC_API_KEY in .env." };
    if (err.status === 429) return { error: "Claude API rate limit reached. Try again in a moment." };
    return { error: `Claude API error: ${err.message}` };
  }
}

// ── POST /api/scan — single page ──────────────────────────────────────────

app.post("/api/scan", async (req, res) => {
  let parsedUrl;
  try {
    parsedUrl = validateUrl(req.body?.url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const result = await fetchAndExtractSchemas(parsedUrl.href);
    const analysis = await analyzeWithClaude({
      url: parsedUrl.href,
      pageTitle: result.pageTitle,
      metaDescription: result.metaDescription,
      schemas: result.schemas,
      parseErrors: result.parseErrors,
    });
    return res.json({ url: parsedUrl.href, ...result, totalSchemas: result.schemas.length, analysis });
  } catch (err) {
    return res.status(200).json({ error: friendlyFetchError(err) });
  }
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

  // Fetch and extract schemas for all pages (concurrency 5)
  const fetchTasks = toScan.map((page) => async () => {
    try {
      const result = await fetchAndExtractSchemas(page.url);
      return { category: page.label, url: page.url, ...result };
    } catch (err) {
      return { category: page.label, url: page.url, error: friendlyFetchError(err), schemas: [], parseErrors: [], fetchMethod: "static" };
    }
  });

  const fetchedPages = await runWithConcurrency(fetchTasks, 5);

  // AI analysis for all pages (concurrency 3)
  const analysisTasks = fetchedPages.map((page) => async () => {
    if (page.error) return null;
    return analyzeWithClaude({
      url: page.url,
      pageTitle: page.pageTitle,
      metaDescription: page.metaDescription,
      schemas: page.schemas || [],
      parseErrors: page.parseErrors || [],
    });
  });

  const analyses = await runWithConcurrency(analysisTasks, 3);

  const discoveredPages = fetchedPages.map((page, i) => ({ ...page, analysis: analyses[i] }));

  const totalSchemasFound = discoveredPages.reduce((a, p) => a + (p.schemas?.length || 0), 0);
  const totalParseErrors = discoveredPages.reduce((a, p) => a + (p.parseErrors?.length || 0), 0);

  // Use AI scores when available, fall back to schema-count-based score
  const aiScores = discoveredPages
    .map((p) => p.analysis?.overallScore)
    .filter((s) => typeof s === "number");
  const averageAiScore = aiScores.length > 0
    ? Math.round(aiScores.reduce((a, b) => a + b, 0) / aiScores.length)
    : null;

  return res.json({
    siteUrl: parsedUrl.href,
    discoveredPages,
    categoriesNotFound,
    totalSchemasFound,
    totalParseErrors,
    averageAiScore,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Schema Checker running at http://localhost:${PORT}`);
});
