require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: ['https://kotreet.com', 'https://kotreet-ddf7f.web.app', 'http://localhost:3000'],
  methods: ['POST', 'GET'],
}));
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const removeStopwords = (text) => {
  const stopwords = ['이', '가', '을', '를', '은', '는', '에', '의', '로', '와', '과', '도', '만', '에서', '으로', '하고', '그리고', '또한', '그런데', '하지만', '그래서', '그러나', '또', '더', '매우', '정말', '진짜', '너무', '아주', '굉장히', '엄청', '완전', 'ㅋㅋ', 'ㅎㅎ', 'ㅠㅠ', 'ㅜㅜ', '...', '..', '!', '?', '~'];
  let cleaned = text;
  stopwords.forEach(word => { cleaned = cleaned.replace(new RegExp(word, 'g'), ' '); });
  return cleaned.replace(/\s+/g, ' ').trim();
};

const getCategoryPrompt = (category, indicators) => {
  return `You are an expert reviewer analyzing Korean ${category} for foreign tourists.
Based on the reviews provided, evaluate the following indicators on a scale of 1-10:

${indicators.map((ind, i) => `${i + 1}. ${ind}`).join('\n')}

Also provide:
- A confidence score (1-10) for your analysis
- A one-line summary in English targeting foreign tourists (max 100 chars)
- A one-line summary in Korean (max 50 chars)

Response format (JSON only, no markdown):
{"scores": [score1, score2, ...], "confidence": number, "summaryEn": "string", "summaryKo": "string"}`;
};

app.get('/', (req, res) => { res.json({ status: 'ok', message: 'Kotreet Scraper API v2' }); });

// 네이버
app.post('/api/scrape/naver', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`https://m.place.naver.com/search/${encodeURIComponent(shopName)}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('a[href*="/restaurant/"], a[href*="/cafe/"], a[href*="/hairshop/"], a[href*="/place/"]', { timeout: 10000 }).catch(() => {});
    const first = await page.$('a[href*="/restaurant/"], a[href*="/cafe/"], a[href*="/hairshop/"], a[href*="/place/"]');
    if (first) { await first.click(); await page.waitForLoadState('networkidle'); }
    const tab = await page.$('text=리뷰');
    if (tab) { await tab.click(); await page.waitForTimeout(2000); }
    const reviews = await page.$$eval('.pui__vn15t2 span, .pui__xtsQN-, .YeINN', el => el.slice(0, 30).map(e => e.textContent?.trim()).filter(Boolean));
    await browser.close();
    res.json({ success: true, reviews: reviews.slice(0, 30), source: 'naver' });
  } catch (e) { if (browser) await browser.close(); res.json({ success: false, reviews: [], error: e.message, source: 'naver' }); }
});

// 카카오
app.post('/api/scrape/kakao', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`https://m.map.kakao.com/actions/searchView?q=${encodeURIComponent(shopName)}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const first = await page.$('.search_item, .item_place');
    if (first) { await first.click(); await page.waitForTimeout(2000); }
    const tab = await page.$('text=후기');
    if (tab) { await tab.click(); await page.waitForTimeout(2000); }
    const reviews = await page.$$eval('.txt_comment, .review_contents, .comment_info', el => el.slice(0, 30).map(e => e.textContent?.trim()).filter(Boolean));
    await browser.close();
    res.json({ success: true, reviews: reviews.slice(0, 30), source: 'kakao' });
  } catch (e) { if (browser) await browser.close(); res.json({ success: false, reviews: [], error: e.message, source: 'kakao' }); }
});

// 캐치테이블
app.post('/api/scrape/catchTable', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`https://app.catchtable.co.kr/ct/search/result?keyword=${encodeURIComponent(shopName)}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const first = await page.$('.search-item, [class*="SearchResultItem"], a[href*="/shop/"]');
    if (first) { await first.click(); await page.waitForTimeout(2000); }
    const tab = await page.$('text=리뷰');
    if (tab) { await tab.click(); await page.waitForTimeout(2000); }
    const reviews = await page.$$eval('[class*="review"], [class*="Review"], .review-content', el => el.slice(0, 30).map(e => e.textContent?.trim()).filter(Boolean));
    await browser.close();
    res.json({ success: true, reviews: reviews.slice(0, 30), source: 'catchTable' });
  } catch (e) { if (browser) await browser.close(); res.json({ success: false, reviews: [], error: e.message, source: 'catchTable' }); }
});

// 망고플레이트
app.post('/api/scrape/mangoplate', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`https://www.mangoplate.com/search/${encodeURIComponent(shopName)}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const first = await page.$('.list-restaurant-item, a[href*="/restaurants/"]');
    if (first) { await first.click(); await page.waitForTimeout(2000); }
    const more = await page.$('.btn-more');
    if (more) { await more.click(); await page.waitForTimeout(1500); }
    const reviews = await page.$$eval('.RestaurantReviewItem, .review-content, [class*="review"] p', el => el.slice(0, 30).map(e => e.textContent?.trim()).filter(Boolean));
    await browser.close();
    res.json({ success: true, reviews: reviews.slice(0, 30), source: 'mangoplate' });
  } catch (e) { if (browser) await browser.close(); res.json({ success: false, reviews: [], error: e.message, source: 'mangoplate' }); }
});

// 다이닝코드
app.post('/api/scrape/diningcode', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`https://www.diningcode.com/list.dc?query=${encodeURIComponent(shopName)}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const first = await page.$('.dc-restaurant, .PoiBlock, a[href*="/profile.dc"]');
    if (first) { await first.click(); await page.waitForTimeout(2000); }
    const tab = await page.$('text=리뷰');
    if (tab) { await tab.click(); await page.waitForTimeout(2000); }
    const reviews = await page.$$eval('.ReviewText, .review-content, .comment', el => el.slice(0, 30).map(e => e.textContent?.trim()).filter(Boolean));
    await browser.close();
    res.json({ success: true, reviews: reviews.slice(0, 30), source: 'diningcode' });
  } catch (e) { if (browser) await browser.close(); res.json({ success: false, reviews: [], error: e.message, source: 'diningcode' }); }
});

// AI 분석
app.post('/api/analyze-manual', async (req, res) => {
  const { reviewText, category, indicators } = req.body;
  if (!reviewText || !category || !indicators || indicators.length === 0) return res.status(400).json({ error: 'reviewText, category, indicators required' });
  try {
    const cleaned = removeStopwords(reviewText);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent([getCategoryPrompt(category, indicators), `\n\nReviews:\n${cleaned.slice(0, 6000)}`]);
    const text = result.response.text();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid AI response');
    const analysis = JSON.parse(match[0]);
    res.json({ success: true, analysis: { scores: analysis.scores, confidence: analysis.confidence, summaryEn: analysis.summaryEn, summaryKo: analysis.summaryKo, indicators } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 재분석
app.post('/api/reanalyze', async (req, res) => {
  const { reviewText, category, indicators, previousAnalysis, feedback } = req.body;
  if (!reviewText || !feedback) return res.status(400).json({ error: 'reviewText and feedback required' });
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `${getCategoryPrompt(category, indicators)}\n\nPrevious analysis:\n${JSON.stringify(previousAnalysis)}\n\nFeedback:\n${feedback}\n\nRe-analyze considering the feedback.`;
    const cleaned = removeStopwords(reviewText);
    const result = await model.generateContent([prompt, `\n\nReviews:\n${cleaned.slice(0, 6000)}`]);
    const text = result.response.text();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid AI response');
    const analysis = JSON.parse(match[0]);
    res.json({ success: true, analysis: { scores: analysis.scores, confidence: analysis.confidence, summaryEn: analysis.summaryEn, summaryKo: analysis.summaryKo, indicators } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.listen(PORT, () => { console.log(`Kotreet Scraper running on port ${PORT}`); });
