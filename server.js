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
- A shop description in Korean (descriptionKo) for foreign tourists, including: a brief intro paragraph about what makes this place special, key features as bullet points (3-5 items), and a short overview section with location area, price range ($-$$$), style, and supported languages. Keep it concise and informative. Max 500 chars.
- The same description translated to English (descriptionEn). Max 500 chars.
- Pick the top 10 most positive/praising reviews from the input. For each, extract:
  - userId: mask the ID like "abc***" (first 3 chars + ***)
  - date: the date if available, otherwise "N/A"
  - rating: star rating 1-5 if available, otherwise 5
  - content: the full review text (max 150 chars)

Response format (JSON only, no markdown):
{"scores": [score1, score2, ...], "confidence": number, "summaryEn": "string", "summaryKo": "string", "descriptionKo": "string", "descriptionEn": "string", "bestReviews": [{"userId": "abc***", "date": "2024.12.01", "rating": 5, "content": "..."}]}`;
};

app.get('/', (req, res) => { res.json({ status: 'ok', message: 'Kotreet Scraper API v3' }); });

// 네이버
app.post('/api/scrape/naver', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 430, height: 932 });
    await page.goto(`https://m.search.naver.com/search.naver?query=${encodeURIComponent(shopName + ' 리뷰')}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 네이버 플레이스 리뷰 영역 찾기
    const placeLink = await page.$('a[href*="place.naver.com"]');
    if (placeLink) {
      const href = await placeLink.getAttribute('href');
      if (href) {
        // 플레이스 ID 추출 후 리뷰 페이지로 직접 이동
        const match = href.match(/place\.naver\.com\/[^/]+\/(\d+)/);
        if (match) {
          await page.goto(`https://m.place.naver.com/restaurant/${match[1]}/review/visitor`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await page.waitForTimeout(3000);
          // 더보기 몇번 클릭
          for (let i = 0; i < 3; i++) {
            const more = await page.$('a[class*="more"], button[class*="more"]');
            if (more) { await more.click(); await page.waitForTimeout(1500); }
          }
        }
      }
    }

    // 리뷰 텍스트 수집 (다양한 셀렉터)
    const reviews = await page.$$eval(
      '.pui__vn15t2 span, .pui__xtsQN-, .YeINN, [class*="txt_comment"], [class*="review_content"], .zPfVt',
      els => els.slice(0, 50).map(e => e.textContent?.trim()).filter(t => t && t.length > 10)
    );

    await browser.close();
    res.json({ success: true, reviews: [...new Set(reviews)].slice(0, 30), source: 'naver' });
  } catch (e) { if (browser) await browser.close(); res.json({ success: false, reviews: [], error: e.message, source: 'naver' }); }
});

// 카카오
app.post('/api/scrape/kakao', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`https://m.map.kakao.com/actions/searchView?q=${encodeURIComponent(shopName)}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const first = await page.$('.search_item, .item_place');
    if (first) { await first.click(); await page.waitForTimeout(2000); }
    const tab = await page.$('text=후기');
    if (tab) { await tab.click(); await page.waitForTimeout(2000); }
    const reviews = await page.$$eval('.txt_comment, .review_contents, .comment_info', el => el.slice(0, 30).map(e => e.textContent?.trim()).filter(t => t && t.length > 10));
    await browser.close();
    res.json({ success: true, reviews: reviews.slice(0, 30), source: 'kakao' });
  } catch (e) { if (browser) await browser.close(); res.json({ success: false, reviews: [], error: e.message, source: 'kakao' }); }
});

// 구글
app.post('/api/scrape/google', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 430, height: 932 });
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(shopName)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // 첫번째 결과 클릭
    const firstResult = await page.$('a[href*="/maps/place/"]');
    if (firstResult) { await firstResult.click(); await page.waitForTimeout(3000); }

    // 리뷰 탭 클릭
    const reviewTab = await page.$('button[aria-label*="리뷰"], button[aria-label*="review"], button[data-tab-index="1"]');
    if (reviewTab) { await reviewTab.click(); await page.waitForTimeout(2000); }

    // 스크롤 몇번
    const scrollable = await page.$('.m6QErb.DxyBCb, [class*="review-dialog"]');
    if (scrollable) {
      for (let i = 0; i < 5; i++) {
        await scrollable.evaluate(el => el.scrollTop = el.scrollHeight);
        await page.waitForTimeout(1500);
      }
    }

    const reviews = await page.$$eval(
      '.wiI7pd, [class*="review-text"], .MyEned span',
      els => els.slice(0, 50).map(e => e.textContent?.trim()).filter(t => t && t.length > 10)
    );

    await browser.close();
    res.json({ success: true, reviews: [...new Set(reviews)].slice(0, 30), source: 'google' });
  } catch (e) { if (browser) await browser.close(); res.json({ success: false, reviews: [], error: e.message, source: 'google' }); }
});

// 캐치테이블
app.post('/api/scrape/catchTable', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`https://app.catchtable.co.kr/ct/search/result?keyword=${encodeURIComponent(shopName)}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const first = await page.$('.search-item, [class*="SearchResultItem"], a[href*="/shop/"]');
    if (first) { await first.click(); await page.waitForTimeout(2000); }
    const tab = await page.$('text=리뷰');
    if (tab) { await tab.click(); await page.waitForTimeout(2000); }
    const reviews = await page.$$eval('[class*="review"], [class*="Review"], .review-content', el => el.slice(0, 30).map(e => e.textContent?.trim()).filter(t => t && t.length > 10));
    await browser.close();
    res.json({ success: true, reviews: reviews.slice(0, 30), source: 'catchTable' });
  } catch (e) { if (browser) await browser.close(); res.json({ success: false, reviews: [], error: e.message, source: 'catchTable' }); }
});

// 다이닝코드
app.post('/api/scrape/diningcode', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`https://www.diningcode.com/list.dc?query=${encodeURIComponent(shopName)}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const first = await page.$('.dc-restaurant, .PoiBlock, a[href*="/profile.dc"]');
    if (first) { await first.click(); await page.waitForTimeout(2000); }
    const tab = await page.$('text=리뷰');
    if (tab) { await tab.click(); await page.waitForTimeout(2000); }
    const reviews = await page.$$eval('.ReviewText, .review-content, .comment', el => el.slice(0, 30).map(e => e.textContent?.trim()).filter(t => t && t.length > 10));
    await browser.close();
    res.json({ success: true, reviews: reviews.slice(0, 30), source: 'diningcode' });
  } catch (e) { if (browser) await browser.close(); res.json({ success: false, reviews: [], error: e.message, source: 'diningcode' }); }
});

// AI 분석 (bestReviews 포함)
app.post('/api/analyze-manual', async (req, res) => {
  const { reviewText, category, indicators } = req.body;
  if (!reviewText || !category || !indicators || indicators.length === 0) return res.status(400).json({ error: 'reviewText, category, indicators required' });
  try {
    const cleaned = removeStopwords(reviewText);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent([getCategoryPrompt(category, indicators), `\n\nReviews:\n${cleaned.slice(0, 8000)}`]);
    const text = result.response.text();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid AI response');
    const analysis = JSON.parse(match[0]);
    res.json({ success: true, analysis: { scores: analysis.scores, confidence: analysis.confidence, summaryEn: analysis.summaryEn, summaryKo: analysis.summaryKo, descriptionKo: analysis.descriptionKo || '', descriptionEn: analysis.descriptionEn || '', bestReviews: analysis.bestReviews || [], indicators } });
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
    const result = await model.generateContent([prompt, `\n\nReviews:\n${cleaned.slice(0, 8000)}`]);
    const text = result.response.text();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid AI response');
    const analysis = JSON.parse(match[0]);
    res.json({ success: true, analysis: { scores: analysis.scores, confidence: analysis.confidence, summaryEn: analysis.summaryEn, summaryKo: analysis.summaryKo, descriptionKo: analysis.descriptionKo || '', descriptionEn: analysis.descriptionEn || '', bestReviews: analysis.bestReviews || [], indicators } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 9개국어 번역
app.post('/api/translate', async (req, res) => {
  const { summaryKo, descriptionKo, languages } = req.body;
  if (!summaryKo || !languages) return res.status(400).json({ error: 'summaryKo and languages required' });
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const langNames = { en: 'English', ja: 'Japanese', zh: 'Chinese (Simplified)', vi: 'Vietnamese', th: 'Thai', id: 'Indonesian', es: 'Spanish', fr: 'French' };
    const prompt = `Translate the following Korean text to these languages: ${languages.map(l => langNames[l] || l).join(', ')}.

Summary (Korean): ${summaryKo}

Description (Korean): ${descriptionKo || ''}

Response format (JSON only, no markdown):
{${languages.map(l => `"${l}": {"summary": "translated summary", "description": "translated description"}`).join(', ')}}`;
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid response');
    const translations = JSON.parse(match[0]);
    res.json({ success: true, translations });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.listen(PORT, () => { console.log(`Kotreet Scraper running on port ${PORT}`); });
