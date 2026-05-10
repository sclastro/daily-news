/**
 * fetch-news.js（最終版）
 * - 五個新聞類別
 * - Gemini 2.0 Flash Lite
 * - 同日資料強制覆蓋
 * - 自動重試機制（最多 3 次，每次等 30 秒）
 * - 類別間等待 15 秒避免 rate limit
 */

const axios = require('axios');
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// ── 環境變數 ──
const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY;
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;

// ── 初始化 ──
const rssParser = new Parser();
const genAI     = new GoogleGenerativeAI(GEMINI_API_KEY);
const model     = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-lite' });

// ── 五個新聞類別 ──
const CATEGORIES = [
  {
    id: 'hk',
    name: '本地新聞（香港）',
    newsdata: { q: '香港', language: 'zh' },
    rssKeyword: '香港新聞',
  },
  {
    id: 'world',
    name: '國際新聞',
    newsdata: { q: 'international world politics', language: 'en' },
    rssKeyword: '國際新聞 世界局勢',
  },
  {
    id: 'finance',
    name: '財經新聞',
    newsdata: { q: 'economy finance stock market', language: 'en' },
    rssKeyword: '財經新聞 股市 經濟',
  },
  {
    id: 'ai',
    name: 'AI 相關新聞',
    newsdata: { q: 'artificial intelligence AI LLM', language: 'en' },
    rssKeyword: 'AI artificial intelligence 2026',
  },
  {
    id: 'china',
    name: '大中華新聞',
    newsdata: { q: '中國 台灣 兩岸', language: 'zh' },
    rssKeyword: '中國 台灣 大中華新聞',
  },
];

// ── 從 NewsData.io 抓取 ──
async function fetchFromNewsData(params) {
  try {
    const response = await axios.get('https://newsdata.io/api/1/news', {
      params: { apikey: NEWSDATA_API_KEY, ...params, size: 10 },
      timeout: 15000,
    });
    return response.data.results || [];
  } catch (err) {
    console.warn(`NewsData.io 抓取失敗: ${err.message}`);
    return [];
  }
}

// ── 從 Google News RSS 抓取 ──
async function fetchFromGoogleRSS(keyword) {
  try {
    const encoded = encodeURIComponent(keyword);
    const url = `https://news.google.com/rss/search?q=${encoded}&hl=zh-HK&gl=HK&ceid=HK:zh-Hant`;
    const feed = await rssParser.parseURL(url);
    return (feed.items || []).slice(0, 10).map(item => ({
      title: item.title,
      description: item.contentSnippet || '',
      link: item.link,
      pubDate: item.pubDate,
      source_id: item.creator || 'Google News',
    }));
  } catch (err) {
    console.warn(`Google RSS 抓取失敗: ${err.message}`);
    return [];
  }
}

// ── 用 Gemini 總結（含重試機制）──
async function summarizeWithGemini(articles, categoryName) {
  const articleList = articles.map((a, i) =>
    `[${i + 1}] 標題: ${a.title}\n內容: ${a.description || '無'}\n來源: ${a.source_id || '未知'}\n連結: ${a.link || a.url || ''}`
  ).join('\n\n');

  const prompt = `你是專業繁體中文新聞編輯。強制要求：所有輸出必須100%繁體中文，包括標題和摘要，絕對不可以出現任何英文字。

以下是今日「${categoryName}」新聞列表：
${articleList}

要求：
1. 選出最重要的 5 篇（優先政治、經濟、外交、科技，排除娛樂體育八卦）
2. 避免選題材重複的新聞
3. 所有英文或簡體標題必須翻譯成繁體中文
4. 每篇寫 2 句繁體中文摘要：第一句說明事件核心，第二句說明影響或背景
5. 來源媒體名稱翻譯成中文（例如 BBC → 英國廣播公司，Reuters → 路透社）

只回覆以下 JSON 格式，不要任何其他文字、不要 markdown 符號：
[
  {
    "title": "繁體中文標題",
    "summary": "第一句說明事件。第二句說明影響或背景。",
    "source": "中文來源名稱",
    "url": "完整連結",
    "publishedAt": "發佈時間"
  }
]`;

  // 最多重試 3 次
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`  Gemini 嘗試第 ${attempt} 次...`);
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const cleaned = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      console.log(`  ✅ Gemini 第 ${attempt} 次成功`);
      return parsed;
    } catch (err) {
      console.warn(`  Gemini 第 ${attempt} 次失敗: ${err.message}`);
      if (attempt < 3) {
        console.log(`  等待 30 秒後重試...`);
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }

  // 三次都失敗，使用備援方案（直接用原文前 5 篇）
  console.warn('  Gemini 三次都失敗，使用備援方案');
  return articles.slice(0, 5).map(a => ({
    title: a.title || '無標題',
    summary: (a.description || '暫無摘要').slice(0, 150),
    source: a.source_id || '未知來源',
    url: a.link || a.url || '#',
    publishedAt: a.pubDate || new Date().toISOString(),
  }));
}

// ── 主流程 ──
async function main() {
  console.log('🚀 開始抓取今日新聞...');
  const today = new Date().toISOString().split('T')[0];

  // 讀取歷史資料
  const dataPath = path.join(__dirname, '../data/news.json');
  let history = {};
  if (fs.existsSync(dataPath)) {
    try {
      history = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    } catch (e) {
      console.warn('讀取歷史資料失敗，重新開始');
    }
  }

  // 同日資料強制覆蓋
  if (history[today]) {
    console.log(`⚠️ 今日 ${today} 已有資料，強制覆蓋更新。`);
    delete history[today];
  }

  const todayData = {};

  for (const cat of CATEGORIES) {
    console.log(`\n📰 處理類別: ${cat.name}`);

    // 並行抓取兩個來源
    const [ndArticles, rssArticles] = await Promise.all([
      fetchFromNewsData(cat.newsdata),
      fetchFromGoogleRSS(cat.rssKeyword),
    ]);

    // 合併去重
    const allArticles = [...ndArticles, ...rssArticles];
    const seen = new Set();
    const unique = allArticles.filter(a => {
      const key = (a.title || '').slice(0, 30);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`  找到 ${unique.length} 篇，交給 Gemini 選出 Top 5...`);
    const top5 = await summarizeWithGemini(unique, cat.name);

    todayData[cat.id] = {
      categoryName: cat.name,
      articles: top5,
    };

    // 每個類別之間等 15 秒，避免 rate limit
    console.log(`  完成，等待 15 秒處理下一個類別...`);
    await new Promise(r => setTimeout(r, 15000));
  }

  // 累加歷史（最多 90 天）
  history[today] = todayData;
  const allDates = Object.keys(history).sort().reverse();
  if (allDates.length > 90) {
    allDates.slice(90).forEach(d => delete history[d]);
  }

  // 寫入 JSON
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(history, null, 2), 'utf8');
  console.log(`\n✅ 完成！今日 ${today} 新聞已儲存。`);
}

main().catch(err => {
  console.error('❌ 執行失敗:', err);
  process.exit(1);
});
