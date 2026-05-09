/**
 * fetch-news.js
 * 主要新聞抓取 + AI 總結腳本
 * 每日由 GitHub Actions 自動執行
 */

const axios = require('axios');
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// ── 環境變數（從 GitHub Secrets 讀取）──
const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY;
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;

// ── 初始化工具 ──
const rssParser = new Parser();
const genAI     = new GoogleGenerativeAI(GEMINI_API_KEY);
const model     = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// ── 新聞類別設定 ──

// 將 CATEGORIES 改成以下版本
const CATEGORIES = [
  {
    id: 'hk',
    name: '本地新聞（香港）',
    newsdata: { q: '香港', language: 'zh' },  // 去掉 country
    rssKeyword: '香港 新聞 site:hk',
  },
  {
    id: 'china',
    name: '大中華新聞',
    newsdata: { q: '中國 OR 台灣 OR 北京', language: 'zh' },
    rssKeyword: '中國 台灣 新聞',
  },
  {
    id: 'world',
    name: '國際新聞',
    newsdata: { q: 'world news international', language: 'en' },
    rssKeyword: '國際新聞',
  },
  {
    id: 'ai',
    name: 'AI 相關新聞',
    newsdata: { q: 'artificial intelligence ChatGPT Gemini', language: 'en' },
    rssKeyword: 'AI artificial intelligence 2026',
  },
];

// ── 1. 從 NewsData.io 抓取新聞 ──
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

// ── 2. 從 Google News RSS 抓取新聞（補充）──
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

// ── 3. 用 Gemini 選出 Top 5 並生成摘要 ──
async function summarizeWithGemini(articles, categoryName) {
  const articleList = articles.map((a, i) =>
    `[${i + 1}] 標題: ${a.title}\n內容: ${a.description || '無'}\n來源: ${a.source_id || '未知'}\n連結: ${a.link || a.url || ''}`
  ).join('\n\n');

  const prompt = `
你是一位專業新聞編輯。以下是今日「${categoryName}」的新聞列表：

${articleList}

請完成以下任務：
1. 從以上新聞中選出最重要、最具代表性的 5 篇（避免選重複題材）
2. 為每篇新聞撰寫 1-2 句繁體中文摘要（簡潔清晰，說明事件核心）
3. 如果新聞是英文，標題和摘要都請翻譯成繁體中文

請以 JSON 格式回覆，只回覆 JSON，不要任何其他文字或 markdown 格式：
[
  {
    "title": "新聞標題（繁體中文）",
    "summary": "1-2 句摘要",
    "source": "來源媒體名稱",
    "url": "完整連結",
    "publishedAt": "發佈時間"
  }
]
`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    // 清理 Gemini 有時會加的 markdown 格式符號
    const cleaned = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn(`Gemini 總結失敗: ${err.message}，使用備援方案`);
    // 失敗時直接返回前 5 篇原文
    return articles.slice(0, 5).map(a => ({
      title: a.title || '無標題',
      summary: (a.description || '暫無摘要').slice(0, 150),
      source: a.source_id || '未知來源',
      url: a.link || a.url || '#',
      publishedAt: a.pubDate || new Date().toISOString(),
    }));
  }
}

// ── 4. 主流程 ──
async function main() {
  console.log('🚀 開始抓取今日新聞...');
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // 讀取現有歷史資料
  const dataPath = path.join(__dirname, '../data/news.json');
  let history = {};
  if (fs.existsSync(dataPath)) {
    try {
      history = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    } catch (e) {
      console.warn('讀取歷史資料失敗，重新開始');
    }
  }

  // 如果今日已有資料，跳過
  if (history[today]) {
    console.log(`⚠️ 今日 ${today} 已有資料，跳過。如需重新抓取請先刪除該日期資料。`);
    return;
  }

  const todayData = {};

  // 逐個類別處理
  for (const cat of CATEGORIES) {
    console.log(`\n📰 處理類別: ${cat.name}`);

    // 並行抓取兩個來源
    const [ndArticles, rssArticles] = await Promise.all([
      fetchFromNewsData(cat.newsdata),
      fetchFromGoogleRSS(cat.rssKeyword),
    ]);

    // 合併去重（按標題前 30 字去重）
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

    // 等 2 秒避免 API 速率限制
    await new Promise(r => setTimeout(r, 2000));
  }

  // 累加到歷史資料（最多保留 90 天）
  history[today] = todayData;
  const allDates = Object.keys(history).sort().reverse();
  if (allDates.length > 90) {
    allDates.slice(90).forEach(d => delete history[d]);
  }

  // 確保資料夾存在並寫入 JSON
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(history, null, 2), 'utf8');
  console.log(`\n✅ 完成！今日 ${today} 新聞已儲存至 data/news.json`);
}

main().catch(err => {
  console.error('❌ 執行失敗:', err);
  process.exit(1);
});
