const axios = require('axios');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY;
const rssParser = new Parser();

const CATEGORIES = [
  { id: 'hk', name: '本地新聞（香港）', newsdata: { q: '香港', language: 'zh' }, rssKeyword: '香港新聞' },
  { id: 'world', name: '國際新聞', newsdata: { q: 'world international politics', language: 'en' }, rssKeyword: '國際新聞' },
  { id: 'finance', name: '財經新聞', newsdata: { q: 'economy finance stock', language: 'en' }, rssKeyword: '財經新聞 股市' },
  { id: 'ai', name: 'AI 相關新聞', newsdata: { q: 'artificial intelligence AI', language: 'en' }, rssKeyword: 'AI 人工智能' },
  { id: 'china', name: '大中華新聞', newsdata: { q: '中國 台灣', language: 'zh' }, rssKeyword: '中國 台灣新聞' },
];

async function fetchFromNewsData(params) {
  try {
    const response = await axios.get('https://newsdata.io/api/1/news', {
      params: { apikey: NEWSDATA_API_KEY, ...params, size: 10 },
      timeout: 15000,
    });
    return response.data.results || [];
  } catch (err) {
    console.warn(`NewsData.io 失敗: ${err.message}`);
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
    console.warn(`Google RSS 失敗: ${err.message}`);
    return [];
  }
}

function selectTop5(articles) {
  const seen = new Set();
  return articles.filter(a => {
    const key = (a.title || '').slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5).map(a => ({
    title: a.title || '無標題',
    summary: (a.description || '點擊連結閱讀全文').slice(0, 200),
    source: a.source_id || '未知來源',
    url: a.link || a.url || '#',
    publishedAt: a.pubDate || new Date().toISOString(),
  }));
}

async function main() {
  console.log('🚀 開始抓取今日新聞...');
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().split('T')[0];
  console.log(`📅 今日日期（香港時間）：${today}`);

  const dataPath = path.join(__dirname, '../data/news.json');
  let history = {};
  if (fs.existsSync(dataPath)) {
    try { history = JSON.parse(fs.readFileSync(dataPath, 'utf8')); }
    catch (e) { console.warn('讀取失敗，重新開始'); }
  }

  if (history[today]) {
    console.log(`⚠️ 今日已有資料，強制覆蓋。`);
    delete history[today];
  }

  const todayData = {};
  for (const cat of CATEGORIES) {
    console.log(`\n📰 處理: ${cat.name}`);
    const [nd, rss] = await Promise.all([
      fetchFromNewsData(cat.newsdata),
      fetchFromGoogleRSS(cat.rssKeyword),
    ]);
    todayData[cat.id] = {
      categoryName: cat.name,
      articles: selectTop5([...nd, ...rss]),
    };
    await new Promise(r => setTimeout(r, 2000));
  }

  history[today] = todayData;
  const dates = Object.keys(history).sort().reverse();
  if (dates.length > 90) dates.slice(90).forEach(d => delete history[d]);

  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(history, null, 2), 'utf8');
  console.log(`\n✅ 完成！今日 ${today} 新聞已儲存。`);
}

main().catch(err => { console.error('❌ 失敗:', err); process.exit(1); });
