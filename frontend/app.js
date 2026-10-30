// ── Config ──
const API_BASE = ((typeof window !== "undefined" && window.__API_URL__) || "http://localhost:8000").replace(/\/+$/, "");

// ── State ──
let currentResult = null;
let timelineChart = null;
let explanationMode = false;

// ── DOM refs ──
const $ = (s) => document.querySelector(s);
const claimInput = $("#claim-input");
const analyzeBtn = $("#analyze-btn");
const clearBtn = $("#clear-btn");
const emptyState = $("#empty-state");
const loadingState = $("#loading-state");
const resultArea = $("#result-area");
const verdictCard = $("#verdict-card");
const verdictLabel = $("#verdict-label");
const verdictConfidence = $("#verdict-confidence");
const verdictReason = $("#verdict-reason");
const relatedList = $("#related-list");
const redditList = $("#reddit-list");
const trendingList = $("#trending-list");
const processBtn = $("#process-btn");
const processPanel = $("#process-panel");
const processContent = $("#process-content");
const shareBtn = $("#share-btn");
const offlineBanner = $("#offline-banner");
const historyList = $("#history-list");
const historyEmpty = $("#history-empty");
const similarityInput = $("#similarity-input");
const similarityBtn = $("#similarity-btn");
const similarityResult = $("#similarity-result");
const similarityPct = $("#similarity-pct");
const similarityFill = $("#similarity-fill");
const technicalContent = $("#technical-content");

// ── Theme ──
function initTheme() {
  const saved = localStorage.getItem("veritas-theme");
  if (saved) {
    document.documentElement.setAttribute("data-theme", saved);
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
  }
  updateThemeBtn();
}
function updateThemeBtn() {
  const t = document.documentElement.getAttribute("data-theme");
  $("#theme-toggle").textContent = t === "dark" ? "Light" : "Dark";
}
$("#theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("veritas-theme", next);
  updateThemeBtn();
});

// ── Explanation mode ──
function initMode() {
  const saved = localStorage.getItem("veritas-mode");
  explanationMode = saved === "explanation";
  applyMode();
}
function applyMode() {
  const toggle = $("#mode-toggle");
  toggle.textContent = explanationMode ? "Simple mode" : "Explanation mode";
  document.querySelectorAll(".explanation-only").forEach(el => {
    el.classList.toggle("hidden", !explanationMode);
  });
}
$("#mode-toggle").addEventListener("click", () => {
  explanationMode = !explanationMode;
  localStorage.setItem("veritas-mode", explanationMode ? "explanation" : "simple");
  applyMode();
});

// ── Toast ──
function showToast(msg, ms = 2500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), ms);
}

// ── History ──
function loadHistory() {
  try {
    const raw = localStorage.getItem("veritas-history");
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return [];
}
function saveHistory(item) {
  let h = loadHistory();
  h = h.filter(x => x.text !== item.text);
  h.unshift(item);
  h = h.slice(0, 20);
  localStorage.setItem("veritas-history", JSON.stringify(h));
  renderHistory();
}
function renderHistory() {
  const h = loadHistory();
  if (h.length === 0) {
    historyEmpty.classList.remove("hidden");
    historyList.innerHTML = "";
    return;
  }
  historyEmpty.classList.add("hidden");
  historyList.innerHTML = h.map(item => `
    <li data-text="${escapeAttr(item.text)}" tabindex="0" role="button" aria-label="Re-check: ${escapeAttr(item.text.slice(0, 60))}">
      <div class="h-verdict" style="color: var(--${item.verdict === 'likely_real' ? 'real' : item.verdict === 'likely_fake' ? 'fake' : 'uncertain'})">${verdictText(item.verdict)}</div>
      <div class="h-text">${escapeHtml(item.text.slice(0, 80))}</div>
    </li>
  `).join("");
  historyList.querySelectorAll("li").forEach(li => {
    li.addEventListener("click", () => {
      claimInput.value = li.dataset.text;
      runAnalysis();
    });
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); li.click(); }
    });
  });
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return s.replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function verdictText(v) {
  if (v === "likely_real") return "Likely Real";
  if (v === "likely_fake") return "Likely Fake";
  return "Uncertain";
}

// ── Loading steps ──
const STEPS = ["step-1", "step-2", "step-3", "step-4", "step-5"];
function showLoading() {
  loadingState.classList.remove("hidden");
  resultArea.classList.add("hidden");
  emptyState.classList.add("hidden");
  STEPS.forEach(id => $("#" + id).classList.remove("active"));
}
function advanceStep(idx) {
  if (idx < STEPS.length) {
    $("#" + STEPS[idx]).classList.add("active");
  }
}

// ── API call ──
async function callAnalyze(text) {
  let resp;
  try {
    resp = await fetch(API_BASE + "/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (_) {
    throw new Error("Could not reach the server at " + API_BASE + ".");
  }
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.detail || "Analysis failed. Please try again.");
  }
  return resp.json();
}

// ── Run analysis ──
async function runAnalysis() {
  const text = claimInput.value.trim();
  if (!text || text.length < 5) {
    showToast("Please enter a claim with at least 5 characters.");
    return;
  }

  analyzeBtn.disabled = true;
  const eb = document.getElementById("error-box");
  if (eb) eb.classList.add("hidden");
  showLoading();

  // Animate steps while waiting
  let stepIdx = 0;
  const stepTimer = setInterval(() => {
    advanceStep(stepIdx);
    stepIdx++;
    if (stepIdx >= STEPS.length) clearInterval(stepTimer);
  }, 600);

  try {
    const result = await callAnalyze(text);
    clearInterval(stepTimer);
    STEPS.forEach(id => $("#" + id).classList.add("active"));
    await new Promise(r => setTimeout(r, 400));

    currentResult = result;
    currentResult._input = text;

    localStorage.setItem("veritas-last", JSON.stringify(currentResult));
    offlineBanner.classList.add("hidden");

    saveHistory({
      text: text.slice(0, 200),
      verdict: result.verdict,
      confidence: result.confidence,
      reason: result.reason,
      ts: Date.now(),
    });

    renderResult(result);
  } catch (e) {
    clearInterval(stepTimer);
    loadingState.classList.add("hidden");
    // Try offline fallback
    const last = localStorage.getItem("veritas-last");
    if (last) {
      try {
        const parsed = JSON.parse(last);
        renderResult(parsed);
        offlineBanner.classList.remove("hidden");
      } catch (_) {
        showError(e.message);
      }
    } else {
      showError(e.message);
    }
  } finally {
    analyzeBtn.disabled = false;
  }
}

function showError(msg) {
  loadingState.classList.add("hidden");
  resultArea.classList.add("hidden");
  emptyState.classList.add("hidden");
  let box = document.getElementById("error-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "error-box";
    box.className = "error-card";
    document.getElementById("input-area").after(box);
  }
  box.classList.remove("hidden");
  box.innerHTML = `<strong>Something went wrong.</strong><br>${escapeHtml(msg)}<br><br>
    If this is the first request in a while, the free server may be waking up. Wait about 30 seconds and try again.`;
}

// ── Render result ──
function renderResult(data) {
  loadingState.classList.add("hidden");
  emptyState.classList.add("hidden");
  resultArea.classList.remove("hidden");

  // Verdict
  const vClass = data.verdict === "likely_real" ? "real" : data.verdict === "likely_fake" ? "fake" : "uncertain";
  verdictCard.className = "verdict-card " + vClass;
  verdictLabel.textContent = verdictText(data.verdict);
  verdictConfidence.textContent = data.confidence + "% confidence";
  verdictReason.textContent = data.reason;

  // Timeline
  renderTimeline(data.timeline, data.peak);

  // Related news
  renderRelated(data.articles);

  // Reddit
  renderReddit(data.reddit);

  // Verify links
  const q = encodeURIComponent(data._input || "");
  document.getElementById("v-reuters").href = "https://www.reuters.com/site-search/?query=" + q;
  document.getElementById("v-ap").href = "https://apnews.com/search?q=" + q;
  document.getElementById("v-bbc").href = "https://www.bbc.co.uk/search?q=" + q;
  document.getElementById("v-snopes").href = "https://www.snopes.com/?s=" + q;
  document.getElementById("v-politifact").href = "https://www.politifact.com/search/?q=" + q;

  // Technical
  renderTechnical(data);

  // Store for process button
  processContent.innerHTML = "";

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderTimeline(timeline, peak) {
  if (timelineChart) timelineChart.destroy();
  const ctx = document.getElementById("timeline-chart").getContext("2d");
  const labels = timeline.map(p => {
    const d = new Date(p.hour);
    return d.getHours() + ":00";
  });
  const data = timeline.map(p => p.count);

  timelineChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Mentions",
        data,
        borderColor: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1a6b4a",
        backgroundColor: "rgba(26,107,74,0.08)",
        fill: true,
        tension: 0.35,
        pointRadius: 2,
        pointHoverRadius: 5,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ctx.parsed.y + " mentions",
          },
        },
        annotation: undefined,
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 8, font: { size: 11 }, color: getComputedStyle(document.documentElement).getPropertyValue("--text-secondary").trim() },
        },
        y: {
          beginAtZero: true,
          grid: { color: getComputedStyle(document.documentElement).getPropertyValue("--border").trim() },
          ticks: { font: { size: 11 }, color: getComputedStyle(document.documentElement).getPropertyValue("--text-secondary").trim() },
        },
      },
    },
  });

  $("#peak-note").textContent = peak ? peak.note : "";
}

function renderRelated(articles) {
  if (!articles || articles.length === 0) {
    relatedList.innerHTML = '<p class="muted">No matching articles found in the last 24 hours.</p>';
    return;
  }
  relatedList.innerHTML = articles.map(a => `
    <a class="card-item" href="${escapeAttr(a.url)}" target="_blank" rel="noopener">
      <div class="card-title">${escapeHtml(a.title || "Untitled")}</div>
      <div class="card-meta">
        <span>${escapeHtml(a.domain || "")}</span>
        <span class="badge ${a.credibility}">${a.credibility === "trusted" ? "Trusted" : a.credibility === "low" ? "Low quality" : "Unknown"}</span>
        <span>${timeAgo(a.seendate)}</span>
      </div>
    </a>
  `).join("");
}

function renderReddit(posts) {
  if (!posts || posts.length === 0) {
    redditList.innerHTML = '<p class="muted">No Reddit discussions found for this claim.</p>';
    return;
  }
  redditList.innerHTML = posts.map(p => `
    <a class="card-item" href="${escapeAttr(p.url)}" target="_blank" rel="noopener">
      <div class="card-title">${escapeHtml(p.title)}</div>
      <div class="card-meta">
        <span>r/${escapeHtml(p.subreddit)}</span>
        <span>${p.score} points</span>
        <span>${p.comments} comments</span>
      </div>
    </a>
  `).join("");
}

function renderTechnical(data) {
  const sig = data.signals || {};
  const emb = data.embedding_summary || {};
  const rs = data.r_stats || {};

  technicalContent.innerHTML = `
    <div class="tech-row"><strong>Search query used:</strong> ${escapeHtml(data.query_used || "")}</div>
    <div class="tech-row"><strong>Text vector:</strong> ${emb.method || "hashed bag-of-words"}, ${emb.dimensions || 256} dimensions, norm ${emb.norm}.</div>
    <div class="tech-row"><strong>Chi-squared test (24h spread):</strong> chi-squared = ${rs.chi_squared}, df = ${rs.degrees_of_freedom}, p = ${rs.p_value}, significant = ${rs.significant}</div>
    <div class="tech-row"><strong>Signals:</strong> urgency ${sig.urgency_score}, caps ${sig.caps_ratio}, exclamation ${sig.exclamation_density}, relevant articles ${sig.relevant_articles}, trusted ratio ${sig.trusted_ratio}, low-quality ratio ${sig.low_quality_ratio}, debunk headlines (trusted) ${sig.debunk_trusted}, burst ${sig.burst_ratio}</div>
  `;
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    const diff = Date.now() - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.floor(hrs / 24) + "d ago";
  } catch (_) { return ""; }
}

// ── Process button ──
processBtn.addEventListener("click", async () => {
  if (!currentResult) return;
  const panel = processPanel;
  const isHidden = panel.classList.contains("hidden");
  if (!isHidden) { panel.classList.add("hidden"); return; }

  panel.classList.remove("hidden");
  processContent.innerHTML = "<p>Loading process detail...</p>";

  try {
    const resp = await fetch(API_BASE + "/api/process/" + (currentResult.input_hash || "unknown"));
    const detail = await resp.json();
    renderProcessDetail(detail, currentResult);
  } catch (_) {
    renderProcessDetail(null, currentResult);
  }
});

function renderProcessDetail(detail, result) {
  const sig = result.signals || {};
  const emb = result.embedding_summary || {};
  const rs = result.r_stats || {};

  let html = `<div class="proc-section">
    <h4>1. Input received</h4>
    <p>Your text was hashed to <code>${result.input_hash || "unknown"}</code> and processed at ${result.processed_at || "unknown time"}. Nothing is stored on the server.</p>
  </div>
  <div class="proc-section">
    <h4>2. Keyword query</h4>
    <p>Your claim was reduced to the search query <code>${escapeHtml(result.query_used || "")}</code>.</p>
  </div>
  <div class="proc-section">
    <h4>3. Google News search</h4>
    <p>The query was sent to Google News search for the last 24 hours (widening to 7 days if there were fewer than 3 hits). Each article's publisher was checked against a trusted / low-quality list, and each headline was compared with your claim (${emb.dimensions || 256}-dimension text vector) so unrelated articles are ignored.</p>
  </div>
  <div class="proc-section">
    <h4>4. Spread over 24 hours</h4>
    <p>Article publish times were counted per hour. A chi-squared test checked whether the spread is uniform: chi-squared = ${rs.chi_squared}, df = ${rs.degrees_of_freedom}, p = ${rs.p_value}, significant = ${rs.significant}.</p>
  </div>
  <div class="proc-section">
    <h4>5. Signals and verdict</h4>
    <ul>
      <li>Urgency score: ${sig.urgency_score} (sensational wording)</li>
      <li>Capital-letter ratio: ${sig.caps_ratio}</li>
      <li>Relevant articles found: ${sig.relevant_articles}</li>
      <li>Trusted-source ratio: ${sig.trusted_ratio}</li>
      <li>Low-quality-source ratio: ${sig.low_quality_ratio}</li>
      <li>Debunk headlines from trusted outlets: ${sig.debunk_trusted}</li>
    </ul>
    <p>These are combined into a risk score. Debunking headlines from established outlets weigh most; lack of any credible coverage and sensational wording come next. This is a screening heuristic, not proof. Always check the sources below.</p>
  </div>`;

  if (detail && detail.data_sources) {
    html += `<div class="proc-section">
      <h4>Data sources</h4>
      <ul>${detail.data_sources.map(s => `<li><strong>${escapeHtml(s.name)}</strong>: ${escapeHtml(s.purpose)} (${escapeHtml(s.auth)})</li>`).join("")}</ul>
    </div>`;
  }
  processContent.innerHTML = html;
}

// ── Share ──
shareBtn.addEventListener("click", async () => {
  if (!currentResult) return;
  const params = new URLSearchParams({
    t: (currentResult._input || "").slice(0, 120),
    v: currentResult.verdict,
    c: currentResult.confidence,
  });
  const url = location.origin + location.pathname + "?" + params.toString();
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link copied.");
  } catch (_) {
    showToast("Could not copy automatically. URL: " + url);
  }
});

// ── Similarity ──
similarityBtn.addEventListener("click", async () => {
  const a = currentResult ? currentResult._input : "";
  const b = similarityInput.value.trim();
  if (!a || !b) { showToast("Analyze a claim first, then enter a second one."); return; }
  try {
    const resp = await fetch(API_BASE + "/api/similarity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text_a: a, text_b: b }),
    });
    if (!resp.ok) throw new Error("Comparison failed.");
    const data = await resp.json();
    similarityResult.classList.remove("hidden");
    similarityPct.textContent = data.similarity_percent + "% similar";
    similarityFill.style.width = data.similarity_percent + "%";
  } catch (e) {
    showToast(e.message);
  }
});

// ── Trending ──
async function loadTrending() {
  try {
    const resp = await fetch(API_BASE + "/api/trending");
    if (!resp.ok) throw new Error("fail");
    const data = await resp.json();
    if (data.articles && data.articles.length) {
      trendingList.innerHTML = data.articles.map(a => `
        <a class="card-item" href="${escapeAttr(a.url)}" target="_blank" rel="noopener">
          <div class="card-title">${escapeHtml(a.title || "Untitled")}</div>
          <div class="card-meta"><span>${escapeHtml(a.domain || "")}</span><span>${timeAgo(a.seendate)}</span></div>
        </a>
      `).join("");
    } else {
      trendingList.innerHTML = '<p class="muted">No trending fact checks right now.</p>';
    }
  } catch (_) {
    trendingList.innerHTML = '<p class="muted">Trending feed unavailable.</p>';
  }
}

// ── Event listeners ──
analyzeBtn.addEventListener("click", runAnalysis);
claimInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runAnalysis(); }
});
clearBtn.addEventListener("click", () => {
  claimInput.value = "";
  resultArea.classList.add("hidden");
  emptyState.classList.remove("hidden");
  loadingState.classList.add("hidden");
  currentResult = null;
});
document.querySelectorAll(".example-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    claimInput.value = btn.dataset.example;
    runAnalysis();
  });
});

// ── Init ──
initTheme();
initMode();
renderHistory();
loadTrending();
setInterval(loadTrending, 15 * 60 * 1000);

// Handle share URL
(function handleShareParam() {
  const params = new URLSearchParams(location.search);
  if (params.has("t")) {
    claimInput.value = params.get("t");
  }
})();
