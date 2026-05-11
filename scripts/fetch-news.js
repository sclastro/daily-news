/**
 * fetch-news.js（GitHub Models 版本）
 * - 使用 GitHub Models 免費 AI（無需信用卡）
 * - 五個新聞類別
 * - 今日有資料就跳過（節省配額）
 * - 香港時間生成日期
 */

const axios = require('axios');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY;
const GH_TOKEN_AI     = process.env.GH_TOKEN_AI;

const rssParser = new Parser();

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

async function summarizeWithGitHubModels(articles, categoryName) {
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
5. 來源媒體名稱翻譯成中文（BBC → 英國廣播公司，Reuters → 路透社）

只回覆 JSON，不要任何其他文字或 markdown：
[
  {
    "title": "繁體中文標題",
    "summary": "第一句說明事件。第二句說明影響或背景。",
    "source": "中文來源名稱",
    "url": "完整連結",
    "publishedAt": "發佈時間"
  }
]`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`  GitHub Models 嘗試第 ${attempt} 次...`);
      const response = await axios.post(
        'https://models.inference.ai.azure.com/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 2000,
        },
        {
          headers: {
            'Authorization': `Bearer ${GH_TOKEN_AI}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
      );

      const text = response.data.choices[0].message.content;
      const cleaned = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      console.log(`  ✅ GitHub Models 第 ${attempt} 次成功`);
      return parsed;

    } catch (err) {
      console.warn(`  GitHub Models 第 ${attempt} 次失敗: ${err.message}`);
      if (attempt < 3) {
        console.log(`  等待 10 秒後重試...`);
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }

  console.warn('  三次都失敗，使用備援方案');
  return articles.slice(0, 5).map(a => ({
    title: a.title || '無標題',
    summary: (a.description || '暫無摘要').slice(0, 150),
    source: a.source_id || '未知來源',
    url: a.link || a.url || '#',
    publishedAt: a.pubDate || new Date().toISOString(),
  }));
}

async function main() {
  console.log('🚀 開始抓取今日新聞...');

  // 用香港時間生成日期
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().split('T')[0];
  console.log(`📅 今日日期（香港時間）：${today}`);

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

    const [ndArticles, rssArticles] = await Promise.all([
      fetchFromNewsData(cat.newsdata),
      fetchFromGoogleRSS(cat.rssKeyword),
    ]);

    const allArticles = [...ndArticles, ...rssArticles];
    const seen = new Set();
    const unique = allArticles.filter(a => {
      const key = (a.title || '').slice(0, 30);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`  找到 ${unique.length} 篇，交給 AI 選出 Top 5...`);
    const top5 = await summarizeWithGitHubModels(unique, cat.name);

    todayData[cat.id] = {
      categoryName: cat.name,
      articles: top5,
    };

    console.log(`  完成，等待 5 秒...`);
    await new Promise(r => setTimeout(r, 5000));
  }

  history[today] = todayData;
  const allDates = Object.keys(history).sort().reverse();
  if (allDates.length > 90) {
    allDates.slice(90).forEach(d => delete history[d]);
  }

  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(history, null, 2), 'utf8');
  console.log(`\n✅ 完成！今日 ${today} 新聞已儲存。`);
}

main().catch(err => {
  console.error('❌ 執行失敗:', err);
  process.exit(1);
});
