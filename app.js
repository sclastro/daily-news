/**
 * app.js — 前端邏輯
 * 讀取 ../data/news.json，渲染四個類別的新聞卡片
 */

// 類別樣式設定
const CATEGORY_CONFIG = {
  hk:    { emoji: '🇭🇰', colorClass: 'red',    label: '本地新聞（香港）' },
  china: { emoji: '🇨🇳', colorClass: 'amber',  label: '大中華新聞' },
  world: { emoji: '🌍',  colorClass: 'green',  label: '國際新聞' },
  ai:    { emoji: '🤖',  colorClass: 'purple', label: 'AI 相關新聞' },
};

// 顏色對應 Tailwind 類別（需預先定義，Tailwind CDN 模式不支援動態拼接）
const COLORS = {
  red:    { bg: 'bg-red-50',    text: 'text-red-700',    border: 'border-red-300',    badge: 'bg-red-100 text-red-700' },
  amber:  { bg: 'bg-amber-50',  text: 'text-amber-700',  border: 'border-amber-300',  badge: 'bg-amber-100 text-amber-700' },
  green:  { bg: 'bg-green-50',  text: 'text-green-700',  border: 'border-green-300',  badge: 'bg-green-100 text-green-700' },
  purple: { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-300', badge: 'bg-purple-100 text-purple-700' },
};

let allNewsData = {};

// ── 頁面載入 ──
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const response = await fetch('data/news.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    allNewsData = await response.json();

    const dates = Object.keys(allNewsData).sort().reverse();
    if (dates.length === 0) { showError('暫無新聞資料，請等待每日自動更新。'); return; }

    populateDateSelect(dates);
    renderNews(dates[0]);

    document.getElementById('updateInfo').textContent =
      `✅ 最後更新：${dates[0]}　|　每日香港時間早上 6 時自動更新`;

  } catch (err) {
    showError(`載入失敗：${err.message}。請確認 data/news.json 存在，並由 GitHub Actions 正確執行。`);
  }
});

// ── 日期選單 ──
function populateDateSelect(dates) {
  const select = document.getElementById('dateSelect');
  dates.forEach(date => {
    const opt = document.createElement('option');
    opt.value = date;
    const today = new Date().toISOString().split('T')[0];
    opt.textContent = date === today ? `今日 ${date}` : date;
    select.appendChild(opt);
  });
  select.addEventListener('change', e => renderNews(e.target.value));
}

// ── 渲染指定日期新聞 ──
function renderNews(date) {
  const container = document.getElementById('newsContainer');
  const dayData = allNewsData[date];
  if (!dayData) { showError('找不到該日期資料'); return; }

  const html = Object.entries(CATEGORY_CONFIG).map(([catId, config]) => {
    const catData = dayData[catId];
    if (!catData?.articles?.length) return '';
    const color = COLORS[config.colorClass];

    const cards = catData.articles.map((article, i) => `
      <article class="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 card-hover">
        <div class="flex items-start gap-3">
          <span class="shrink-0 w-8 h-8 rounded-full ${color.badge} text-sm font-bold flex items-center justify-center">
            ${i + 1}
          </span>
          <div class="flex-1 min-w-0">
            <h3 class="font-semibold text-gray-900 text-sm leading-snug mb-2 line-clamp-2">
              ${escapeHtml(article.title)}
            </h3>
            <p class="text-xs text-gray-600 leading-relaxed mb-3">
              ${escapeHtml(article.summary)}
            </p>
            <div class="flex items-center justify-between text-xs text-gray-400 mb-2">
              <span class="font-medium text-gray-500 truncate max-w-[60%]">${escapeHtml(article.source)}</span>
              <span>${formatTime(article.publishedAt)}</span>
            </div>
            <a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer"
              class="inline-flex items-center gap-1 text-xs ${color.text} font-medium hover:underline">
              閱讀全文 →
            </a>
          </div>
        </div>
      </article>
    `).join('');

    return `
      <section id="cat-${catId}" class="mb-12">
        <div class="flex items-center gap-3 mb-5 pb-3 border-b-2 ${color.border}">
          <span class="text-3xl">${config.emoji}</span>
          <h2 class="text-xl font-bold text-gray-800">${config.label}</h2>
          <span class="ml-auto text-xs font-medium ${color.text} ${color.bg} px-2.5 py-1 rounded-full">Top 5</span>
        </div>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          ${cards}
        </div>
      </section>
    `;
  }).join('');

  container.innerHTML = html || '<p class="text-gray-400 text-center py-20">此日期暫無資料</p>';
}

// ── 跳轉到類別 ──
function scrollToCategory(catId) {
  document.getElementById(`cat-${catId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── 格式化時間 ──
function formatTime(isoString) {
  try {
    return new Date(isoString).toLocaleString('zh-HK', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch { return '未知時間'; }
}

// ── 防 XSS ──
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── 顯示錯誤 ──
function showError(msg) {
  document.getElementById('newsContainer').innerHTML = `
    <div class="text-center py-20">
      <div class="text-5xl mb-4">⚠️</div>
      <p class="text-gray-600 text-lg">${msg}</p>
      <p class="text-gray-400 text-sm mt-2">請確認 GitHub Actions 已成功執行</p>
    </div>
  `;
}
