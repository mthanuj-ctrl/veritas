import asyncio
import hashlib
import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Optional
from urllib.parse import urlparse

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from scipy import stats

app = FastAPI(title="Veritas API", version="2.0.0")

_origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,  # "*" + credentials is invalid; we don't use cookies
    allow_methods=["*"],
    allow_headers=["*"],
)

# Optional: official Google Programmable Search (Custom Search JSON API).
# Leave unset to use Google News search only (no key needed).
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY", "")
GOOGLE_CSE_ID = os.getenv("GOOGLE_CSE_ID", "")
# Region/language for Google News search
GNEWS_HL = os.getenv("GNEWS_HL", "en-IN")
GNEWS_GL = os.getenv("GNEWS_GL", "IN")
GNEWS_CEID = os.getenv("GNEWS_CEID", "IN:en")

UA = "Mozilla/5.0 (compatible; VeritasFactCheck/2.0)"


class AnalyzeRequest(BaseModel):
    text: str


class SimilarityRequest(BaseModel):
    text_a: str
    text_b: str


# ───────────────────────── text helpers ─────────────────────────

STOPWORDS = set("""
a an the and or but if then so of to in on at by for with from as is are was were be been being
this that these those it its has have had will would can could should may might do does did not no
new says said after before over under about into than more most very just also up down out off
you your we our they their he she his her i me my us who whom which what when where why how
""".split())


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def extract_query(text: str, max_terms: int = 8) -> str:
    """Turn a long claim into a short keyword query a news search can handle."""
    text = re.sub(r"https?://\S+", " ", text)
    words = [w for w in tokenize(text) if w not in STOPWORDS and len(w) > 2]
    seen, out = set(), []
    for w in words:
        if w not in seen:
            seen.add(w)
            out.append(w)
    return " ".join(out[:max_terms]) or text[:80]


def embed(text: str, dim: int = 256) -> np.ndarray:
    """Dependency-free hashed bag-of-words (unigrams + bigrams) vector."""
    toks = [t for t in tokenize(text) if t not in STOPWORDS]
    vec = np.zeros(dim, dtype=np.float32)
    grams = toks + [f"{a}_{b}" for a, b in zip(toks, toks[1:])]
    for g in grams:
        h = int(hashlib.md5(g.encode()).hexdigest(), 16)
        vec[h % dim] += 1.0 if (h >> 20) & 1 else -1.0
    n = np.linalg.norm(vec)
    return vec / n if n > 0 else vec


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    d = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / d) if d > 0 else 0.0


# ───────────────────────── credibility ─────────────────────────

TRUSTED_DOMAINS = {
    "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "npr.org",
    "nytimes.com", "washingtonpost.com", "theguardian.com", "wsj.com",
    "economist.com", "nature.com", "science.org", "who.int", "cdc.gov",
    "nih.gov", "snopes.com", "politifact.com", "factcheck.org",
    "fullfact.org", "afp.com", "cnn.com", "abcnews.go.com", "cbsnews.com",
    "nbcnews.com", "usatoday.com", "latimes.com", "bloomberg.com",
    "thehindu.com", "indianexpress.com", "ndtv.com", "hindustantimes.com",
    "timesofindia.indiatimes.com", "livemint.com", "pib.gov.in",
    "aljazeera.com", "france24.com", "dw.com", "boomlive.in", "altnews.in",
}

LOW_QUALITY_DOMAINS = {
    "infowars.com", "naturalnews.com", "beforeitsnews.com",
    "zerohedge.com", "breitbart.com", "thegatewaypundit.com",
    "worldtruth.tv", "yournewswire.com", "neonnettle.com",
    "newspunch.com", "blogspot.com", "wordpress.com",
}


def domain_of(url: str) -> str:
    try:
        d = urlparse(url).netloc.lower()
        return d[4:] if d.startswith("www.") else d
    except Exception:
        return ""


def credibility_badge(domain: str) -> str:
    if not domain:
        return "unknown"
    for t in TRUSTED_DOMAINS:
        if domain == t or domain.endswith("." + t):
            return "trusted"
    for l in LOW_QUALITY_DOMAINS:
        if domain == l or domain.endswith("." + l):
            return "low"
    return "unknown"


# ───────────────────────── data fetchers ─────────────────────────

def _parse_gnews(xml_text: str, limit: int) -> list[dict]:
    items = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return items
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        pub = it.findtext("pubDate") or ""
        src_el = it.find("source")
        src_name = (src_el.text or "").strip() if src_el is not None else ""
        src_url = src_el.get("url", "") if src_el is not None else ""
        # Google appends " - Publisher" to titles
        if src_name and title.endswith(" - " + src_name):
            title = title[: -len(src_name) - 3].strip()
        try:
            dt = parsedate_to_datetime(pub).astimezone(timezone.utc)
        except Exception:
            dt = None
        dom = domain_of(src_url)
        items.append({
            "title": title,
            "url": link,
            "domain": dom or src_name,
            "publisher": src_name,
            "seendate": dt.isoformat() if dt else "",
            "credibility": credibility_badge(dom),
        })
        if len(items) >= limit:
            break
    return items


async def google_news(query: str, window: str = "1d", limit: int = 100) -> list[dict]:
    """Google News search RSS — free, no API key."""
    params = {
        "q": f"{query} when:{window}",
        "hl": GNEWS_HL, "gl": GNEWS_GL, "ceid": GNEWS_CEID,
    }
    try:
        async with httpx.AsyncClient(timeout=15, headers={"User-Agent": UA}, follow_redirects=True) as c:
            r = await c.get("https://news.google.com/rss/search", params=params)
            if r.status_code == 200:
                return _parse_gnews(r.text, limit)
    except Exception:
        pass
    return []


async def google_web(query: str, limit: int = 5) -> list[dict]:
    """Official Google Custom Search JSON API. Only used if keys are configured."""
    if not (GOOGLE_API_KEY and GOOGLE_CSE_ID):
        return []
    params = {"key": GOOGLE_API_KEY, "cx": GOOGLE_CSE_ID, "q": query, "num": min(limit, 10)}
    try:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get("https://www.googleapis.com/customsearch/v1", params=params)
            if r.status_code == 200:
                out = []
                for it in r.json().get("items", [])[:limit]:
                    dom = domain_of(it.get("link", ""))
                    out.append({
                        "title": it.get("title", ""),
                        "url": it.get("link", ""),
                        "domain": dom,
                        "snippet": it.get("snippet", ""),
                        "credibility": credibility_badge(dom),
                    })
                return out
    except Exception:
        pass
    return []


async def fetch_reddit(query: str, limit: int = 5) -> list[dict]:
    # Reddit often blocks datacenter IPs; failure is handled gracefully.
    params = {"q": query, "limit": limit, "sort": "relevance", "t": "week"}
    try:
        async with httpx.AsyncClient(timeout=12, headers={"User-Agent": UA}, follow_redirects=True) as c:
            r = await c.get("https://www.reddit.com/search.json", params=params)
            if r.status_code == 200:
                posts = []
                for ch in r.json().get("data", {}).get("children", [])[:limit]:
                    d = ch.get("data", {})
                    posts.append({
                        "title": d.get("title", ""),
                        "subreddit": d.get("subreddit", ""),
                        "score": d.get("score", 0),
                        "comments": d.get("num_comments", 0),
                        "url": "https://reddit.com" + d.get("permalink", ""),
                    })
                return posts
    except Exception:
        pass
    return []


# ───────────────────────── analysis ─────────────────────────

def build_timeline(articles: list[dict]) -> list[dict]:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    buckets = {now - timedelta(hours=23 - h): 0 for h in range(24)}
    for a in articles:
        if not a["seendate"]:
            continue
        try:
            dt = datetime.fromisoformat(a["seendate"]).astimezone(timezone.utc)
        except Exception:
            continue
        key = dt.replace(minute=0, second=0, microsecond=0)
        if key in buckets:
            buckets[key] += 1
    return [{"hour": k.strftime("%Y-%m-%dT%H:00:00Z"), "count": v} for k, v in sorted(buckets.items())]


def run_chi_square(counts: list[int]) -> dict:
    """Chi-squared goodness-of-fit against a uniform spread over 24h."""
    arr = np.array(counts, dtype=float)
    if len(arr) < 2 or arr.sum() < 5:
        return {"chi_squared": 0.0, "degrees_of_freedom": max(len(arr) - 1, 0),
                "p_value": 1.0, "significant": False, "engine": "scipy",
                "note": "Too few mentions for a meaningful test."}
    chi2, p = stats.chisquare(arr)
    return {"chi_squared": round(float(chi2), 2), "degrees_of_freedom": len(arr) - 1,
            "p_value": round(float(p), 4), "significant": bool(p < 0.05), "engine": "scipy"}


URGENT_WORDS = [
    "breaking", "urgent", "shocking", "you won't believe", "they don't want you to know",
    "wake up", "share before", "deleted", "banned", "censored", "exposed",
    "miracle", "cure", "secret", "conspiracy", "hoax", "scam", "danger",
    "alert", "warning", "emergency", "crisis", "overnight", "all types", "100%",
]


DEBUNK_TERMS = [
    "fact check", "fact-check", "false", "hoax", "fake", "debunk", "misleading", "baseless",
    "not true", "no,", "denies", "denied", "myth", "misinformation", "disinformation",
    "unfounded", "fabricated", "clarifies", "rumour", "rumor", "viral claim", "doctored",
]


def is_debunk(title: str) -> bool:
    t = title.lower()
    return any(k in t for k in DEBUNK_TERMS)


def compute_verdict(text: str, claim_vec: np.ndarray, articles: list[dict], timeline: list[dict]) -> dict:
    """Heuristic risk score from language style + how credible outlets cover the claim.
    This is a screening aid, not a fact-check."""
    s = {}
    tl = text.lower()
    s["urgency_score"] = round(min(sum(1 for w in URGENT_WORDS if w in tl) / 4.0, 1.0), 2)

    alpha = [c for c in text if c.isalpha()]
    s["caps_ratio"] = round(sum(c.isupper() for c in alpha) / max(len(alpha), 1), 2)
    s["exclamation_density"] = round(text.count("!") / max(len(text.split()), 1), 2)

    # Only count articles actually about the claim
    relevant = []
    for a in articles:
        sim = cosine(claim_vec, embed(a["title"]))
        a["relevance"] = round(sim, 2)
        if sim >= 0.18:
            relevant.append(a)
    n = len(relevant)
    trusted = sum(1 for a in relevant if a["credibility"] == "trusted")
    low = sum(1 for a in relevant if a["credibility"] == "low")
    s["relevant_articles"] = n
    debunk_trusted = sum(1 for a in relevant if a["credibility"] == "trusted" and is_debunk(a["title"]))
    debunk_any = sum(1 for a in relevant if is_debunk(a["title"]))
    s["debunk_trusted"] = debunk_trusted
    s["debunk_any"] = debunk_any
    s["trusted_ratio"] = round(trusted / n, 2) if n else 0.0
    s["low_quality_ratio"] = round(low / n, 2) if n else 0.0

    counts = [p["count"] for p in timeline]
    mean_c = float(np.mean(counts)) if counts else 0.0
    s["burst_ratio"] = round(min(max(counts) / mean_c, 10.0), 2) if mean_c > 0 else 1.0

    risk = 0.0
    risk += s["urgency_score"] * 0.30
    risk += min(s["caps_ratio"] * 2, 1.0) * 0.10
    risk += min(s["exclamation_density"] * 3, 1.0) * 0.05
    risk += s["low_quality_ratio"] * 0.15
    # No/low coverage by credible outlets is the strongest "unverified" signal
    risk += (1.0 - min(trusted / 3.0, 1.0)) * 0.35
    risk += min(s["burst_ratio"] / 8.0, 1.0) * 0.05
    # Established outlets publishing debunks/denials is the strongest signal of all
    if debunk_trusted >= 1:
        risk = max(risk, 0.70 + min(debunk_trusted - 1, 3) * 0.08)
    elif debunk_any >= 1:
        risk = max(risk, 0.50)
    risk = round(min(max(risk, 0.0), 1.0), 3)

    if risk >= 0.65:
        verdict = "likely_fake"
    elif risk <= 0.35:
        verdict = "likely_real"
    else:
        verdict = "uncertain"
    confidence = round(abs(risk - 0.5) * 2 * 60 + 40)  # 40–100, higher near the extremes

    reasons = []
    if s["urgency_score"] >= 0.5:
        reasons.append("uses urgent or sensational language")
    if s["caps_ratio"] > 0.15:
        reasons.append("relies heavily on capital letters")
    if s["low_quality_ratio"] >= 0.3:
        reasons.append("appears mostly on low-quality sites")
    if n == 0:
        reasons.append("was not found in any news coverage in the last 24 hours")
    elif trusted == 0:
        reasons.append("has no matching coverage from established publishers")
    elif debunk_trusted == 0 and trusted >= 2:
        reasons.append(f"is covered by {trusted} established publishers")
    if debunk_trusted >= 1:
        reasons.append(f"is disputed or debunked in headlines from {debunk_trusted} established publisher(s)")
    elif debunk_any >= 1:
        reasons.append("is described as false or misleading in related headlines")
    if not reasons:
        reasons.append("shows no strong signals of manipulation")
    return {"verdict": verdict, "confidence": confidence, "risk": risk,
            "reason": "This claim " + ", ".join(reasons) + ".", "signals": s}


# ───────────────────────── endpoints ─────────────────────────

@app.get("/")
async def root():
    return {"service": "veritas-api", "docs": "/docs", "health": "/health"}


@app.get("/health")
async def health():
    return {"status": "ok", "service": "veritas-api"}


@app.get("/api/trending")
async def trending():
    arts = await google_news("fact check", window="1d", limit=6)
    return {"articles": [
        {"title": a["title"], "url": a["url"], "domain": a["domain"], "seendate": a["seendate"]}
        for a in arts[:5]
    ]}


@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest):
    text = req.text.strip()
    if len(text) < 5:
        raise HTTPException(status_code=400, detail="Please enter a claim with at least 5 characters.")

    query = extract_query(text)
    claim_vec = embed(text)

    news_1d, web, reddit = await asyncio.gather(
        google_news(query, "1d", 100),
        google_web(query),
        fetch_reddit(query),
    )
    # Widen the window if nothing came back in 24h (articles only; timeline stays 24h)
    articles = news_1d
    if len(articles) < 3:
        articles = await google_news(query, "7d", 30) or news_1d

    timeline = build_timeline(news_1d)
    counts = [p["count"] for p in timeline]
    peak = max(timeline, key=lambda p: p["count"]) if timeline else {"hour": "", "count": 0}
    mean_c = float(np.mean(counts)) if counts else 0.0
    ratio = peak["count"] / mean_c if mean_c > 0 else 1.0
    if sum(counts) == 0:
        note = "No coverage found in the last 24 hours."
    elif sum(counts) < 10:
        note = "Only a few articles in the last 24 hours, so there is not enough data to judge the spread pattern."
    elif ratio > 5:
        note = "This peak looks bursty: the spike is far above the day's average."
    elif ratio > 2:
        note = "The peak is somewhat elevated but could be organic."
    else:
        note = "The spread pattern looks organic."

    v = compute_verdict(text, claim_vec, articles, timeline)
    chi = run_chi_square(counts)

    shown = sorted(articles, key=lambda a: a.get("relevance", 0), reverse=True)[:8]
    now = datetime.now(timezone.utc)
    return {
        "verdict": v["verdict"],
        "confidence": v["confidence"],
        "reason": v["reason"],
        "signals": v["signals"],
        "query_used": query,
        "timeline": timeline,
        "peak": {"hour": peak["hour"], "count": peak["count"], "note": note},
        "articles": shown,
        "web_results": web,
        "reddit": reddit,
        "r_stats": chi,
        "embedding_summary": {"dimensions": int(claim_vec.shape[0]), "method": "hashed bag-of-words",
                              "norm": round(float(np.linalg.norm(claim_vec)), 2)},
        "input_hash": hashlib.sha256(text.encode()).hexdigest()[:12],
        "processed_at": now.isoformat(),
    }


@app.post("/api/similarity")
async def similarity(req: SimilarityRequest):
    cos = cosine(embed(req.text_a), embed(req.text_b))
    return {"similarity_percent": round(max(cos, 0.0) * 100, 1)}


@app.get("/api/process/{input_hash}")
async def process_detail(input_hash: str):
    return {
        "hash_received": input_hash,
        "data_sources": [
            {"name": "Google News search (RSS)", "purpose": "Related articles and 24-hour coverage timeline", "auth": "None required"},
            {"name": "Google Custom Search API", "purpose": "Optional general web results (only if GOOGLE_API_KEY and GOOGLE_CSE_ID are set)", "auth": "API key"},
            {"name": "Reddit public JSON", "purpose": "Discussion threads (may be blocked from some hosts)", "auth": "None required"},
        ],
        "statistical_test": {"name": "Chi-squared goodness-of-fit", "purpose": "Is the 24h coverage uniform or bursty?", "engine": "scipy"},
        "verdict_rule": "Weighted risk score from language-style signals and how many established publishers cover the claim. It is a screening heuristic, not proof.",
    }
