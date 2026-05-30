const axios = require('axios');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

const rssParser = new Parser({ timeout: 15000 });

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
};

const CATEGORIES = [
  {
    id: 'hk',
    name: '本地新聞（香港）',
    feeds: [
      { url: `https://news.google.com/rss/search?q=${encodeURIComponent('香港新聞')}&hl=zh-HK&gl=HK&ceid=HK:zh-Hant`, source: 'Google News HK' },
      { url: 'https://www.hk01.com/rss/zone/12', source: '香港01' },
      { url: 'https://rthk.hk/rss/rthk9.xml', source: 'RTHK 香港電台' },
    ],
  },
  {
    id: 'world',
    name: '國際新聞',
    feeds: [
      { url: 'https://feeds.bbci.co.uk/zhongwen/trad/rss.xml', source: 'BBC 中文' },
      { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', source: 'BBC World' },
      { url: 'https://rss.dw.com/rdf/rss-chi-all', source: 'DW 德國之聲' },
      { url: 'https://www.rfi.fr/cn/rss', source: 'RFI 法廣' },
      { url: 'https://www.aljazeera.com/xml/rss/all.xml', source: 'Al Jazeera' },
    ],
  },
  {
    id: 'finance',
    name: '財經新聞',
    feeds: [
      { url: `https://news.google.com/rss/search?q=${encodeURIComponent('財經股市')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, source: 'Google News 財經' },
      { url: 'https://feeds.marketwatch.com/marketwatch/topstories/', source: 'MarketWatch' },
      { url: `https://news.google.com/rss/search?q=${encodeURIComponent('finance economy')}&hl=en&gl=US&ceid=US:en`, source: 'Google News Finance' },
    ],
  },
  {
    id: 'ai',
    name: 'AI 相關新聞',
    feeds: [
      { url: 'https://www.ithome.com.tw/rss', source: 'iThome' },
      { url: `https://news.google.com/rss/search?q=${encodeURIComponent('人工智能 AI科技')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, source: 'Google News AI 中文' },
      { url: `https://news.google.com/rss/search?q=${encodeURIComponent('artificial intelligence AI')}&hl=en&gl=US&ceid=US:en`, source: 'Google News AI' },
    ],
  },
  {
    id: 'china',
    name: '大中華新聞',
    feeds: [
      { url: `https://news.google.com/rss/search?q=${encodeURIComponent('台灣 兩岸')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, source: 'Google News 台灣兩岸' },
      { url: `https://news.google.com/rss/search?q=${encodeURIComponent('中國新聞')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, source: 'Google News 中國' },
    ],
  },
];

function isEnglish(text) {
  if (!text || text.length === 0) return false;
  const cjkCount = (text.match(/[一-鿿]/g) || []).length;
  return (cjkCount / text.length) < 0.1;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}

async function translateToZhTW(text) {
  if (!text || !isEnglish(text)) return text;
  const truncated = text.slice(0, 500);

  // Tier 1: Google Translate unofficial API (best quality)
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-TW&dt=t&q=${encodeURIComponent(truncated)}`;
    const res = await axios.get(url, { timeout: 8000 });
    const translated = (res.data?.[0] || []).map(seg => seg[0]).join('');
    if (translated && translated.trim()) return translated;
  } catch {}

  // Tier 2: MyMemory API (stable fallback)
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(truncated)}&langpair=en|zh-TW`;
    const res = await axios.get(url, { timeout: 8000 });
    const translated = res.data?.responseData?.translatedText;
    if (translated && res.data?.responseStatus === 200) return translated;
  } catch {}

  return text;
}

function scoreArticle(article) {
  let score = 0;
  const link = article.link || '';

  const tier1 = ['rthk.hk', 'bbc.co.uk', 'cna.com.tw'];
  const tier2 = ['hk01.com', 'ltn.com.tw', 'udn.com', 'ithome.com.tw', 'dw.com', 'rfi.fr'];
  if (tier1.some(d => link.includes(d))) score += 3;
  else if (tier2.some(d => link.includes(d))) score += 2;

  const pubDate = new Date(article.pubDate);
  if (!isNaN(pubDate.getTime())) {
    const ageHours = (Date.now() - pubDate.getTime()) / 3600000;
    if (ageHours < 6) score += 2;
    else if (ageHours < 12) score += 1;
  }

  if (!isEnglish(article.title || '')) score += 1;

  return score;
}

async function fetchFeed(feedConfig) {
  try {
    const res = await axios.get(feedConfig.url, {
      headers: HTTP_HEADERS,
      timeout: 15000,
      responseType: 'text',
    });
    const feed = await rssParser.parseString(res.data);
    return (feed.items || []).map(item => ({
      title: item.title || '',
      description: item.contentSnippet || item.content || '',
      link: item.link || '',
      pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
      source: feedConfig.source,
    }));
  } catch (err) {
    console.warn(`  ⚠️  ${feedConfig.source} 失敗: ${err.message}`);
    return [];
  }
}

async function fetchCategory(cat) {
  console.log(`\n📰 處理: ${cat.name}`);
  const results = await Promise.allSettled(cat.feeds.map(f => fetchFeed(f)));

  const all = [];
  results.forEach(r => { if (r.status === 'fulfilled') all.push(...r.value); });
  console.log(`  ✓ 共抓取 ${all.length} 篇原始文章`);

  const seen = new Set();
  const unique = all.filter(a => {
    const key = normalizeUrl(a.link);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const top8 = unique
    .sort((a, b) => scoreArticle(b) - scoreArticle(a))
    .slice(0, 8);

  console.log(`  ✓ 去重後 ${unique.length} 篇，評分後取 ${top8.length} 篇`);
  return top8;
}

async function main() {
  console.log('🚀 開始抓取今日新聞...');
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().split('T')[0];
  console.log(`📅 今日日期（香港時間）：${today}`);

  const dataPath = path.join(__dirname, '../data/news.json');
  let history = {};
  if (fs.existsSync(dataPath)) {
    try { history = JSON.parse(fs.readFileSync(dataPath, 'utf8')); }
    catch (e) { console.warn('讀取 news.json 失敗，重新開始'); }
  }

  delete history[today];

  const todayData = {};
  let totalTranslated = 0;
  let totalKeptChinese = 0;

  for (const cat of CATEGORIES) {
    const articles = await fetchCategory(cat);

    const processed = [];
    for (const a of articles) {
      const titleIsEn = isEnglish(a.title);
      const summaryIsEn = isEnglish(a.description);

      const translatedTitle = titleIsEn ? await translateToZhTW(a.title) : a.title;
      const translatedSummary = summaryIsEn ? await translateToZhTW(a.description) : a.description;

      if (titleIsEn) totalTranslated++;
      else totalKeptChinese++;

      processed.push({
        title: translatedTitle || a.title || '無標題',
        summary: (translatedSummary || a.description || '點擊連結閱讀全文').slice(0, 200),
        source: a.source,
        url: a.link || '#',
        publishedAt: a.pubDate || new Date().toISOString(),
      });
    }

    todayData[cat.id] = { categoryName: cat.name, articles: processed };
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n📊 翻譯統計：翻譯 ${totalTranslated} 篇，保留中文 ${totalKeptChinese} 篇`);

  history[today] = todayData;
  const dates = Object.keys(history).sort().reverse();
  if (dates.length > 90) dates.slice(90).forEach(d => delete history[d]);

  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(history, null, 2), 'utf8');
  console.log(`\n✅ 完成！今日 ${today} 新聞已儲存。`);
}

main().catch(err => { console.error('❌ 失敗:', err); process.exit(1); });
