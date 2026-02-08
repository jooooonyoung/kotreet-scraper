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
- A one-line summary in Korean (summaryKo) (max 50 chars)
- A shop description in Korean (descriptionKo) for foreign tourists, including: a brief intro paragraph about what makes this place special, key features as bullet points (3-5 items), and a short overview section with location area, price range ($-$$$), style, and supported languages. Keep it concise and informative. Max 500 chars.
- Pick the top 10 most positive/praising reviews from the input. For each, extract:
  - userId: mask the ID like "abc***" (first 3 chars + ***)
  - date: the date if available, otherwise "N/A"
  - rating: star rating 1-5 if available, otherwise 5
  - content: the full review text (max 150 chars)

Response format (JSON only, no markdown):
{"scores": [score1, score2, ...], "confidence": number, "summaryKo": "string", "descriptionKo": "string", "bestReviews": [{"userId": "abc***", "date": "2024.12.01", "rating": 5, "content": "..."}]}`;
};

app.get('/', (req, res) => { res.json({ status: 'ok', message: 'Kotreet Scraper API v3' }); });

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
    res.json({ success: true, analysis: { scores: analysis.scores, confidence: analysis.confidence, summaryKo: analysis.summaryKo || '', descriptionKo: analysis.descriptionKo || '', bestReviews: analysis.bestReviews || [], indicators } });
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
    res.json({ success: true, analysis: { scores: analysis.scores, confidence: analysis.confidence, summaryKo: analysis.summaryKo || '', descriptionKo: analysis.descriptionKo || '', bestReviews: analysis.bestReviews || [], indicators } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// AI 소개글 생성 (구글 검색 기반)
app.post('/api/generate-description', async (req, res) => {
  const { shopName, category, reviewText } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const categoryKo = { restaurant: '음식점', cafe: '카페', beauty: '뷰티/에스테틱' }[category] || category;
    const prompt = `You are a Korean travel guide writer for foreign tourists visiting Korea.

Search your knowledge about "${shopName}" (category: ${categoryKo}) and write a detailed Korean description for foreign tourists.

Write in Korean. Follow this exact format:

1. Opening paragraph (2-3 sentences): What makes this place special, its reputation, why foreign visitors love it.
2. Second paragraph (2-3 sentences): The experience/atmosphere, value for money, who it's best for.
3. 주요 특징: (3-5 bullet points of key services/menu items/specialties)
4. 개요:
   * 주요 위치: (area/neighborhood)
   * 가격대: ($, $$, or $$$)
   * 스타일: (brief style description)
   * 지원 가능 언어: (Korean + any other languages if known)

${reviewText ? `\nReference reviews for context:\n${reviewText.slice(0, 3000)}` : ''}

Write ONLY the description text in Korean, no JSON, no markdown code blocks. Max 600 chars.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    res.json({ success: true, descriptionKo: text });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// 9개국어 번역
app.post('/api/translate', async (req, res) => {
  const { summaryKo, descriptionKo, languages } = req.body;
  if (!summaryKo || !languages) return res.status(400).json({ error: 'summaryKo and languages required' });
  try {
    const GOOGLE_API_KEY = process.env.GOOGLE_TRANSLATE_KEY || process.env.GOOGLE_API_KEY;
    if (!GOOGLE_API_KEY) throw new Error('GOOGLE_TRANSLATE_KEY not set');

    const translateText = async (text, targetLang) => {
      if (!text) return '';
      const langMap = { zh: 'zh-CN', jp: 'ja' };
      const target = langMap[targetLang] || targetLang;
      const r = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: 'ko', target, format: 'text' })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return d.data?.translations?.[0]?.translatedText || '';
    };

    const translations = {};
    for (const lang of languages) {
      const [summary, description] = await Promise.all([
        translateText(summaryKo, lang),
        translateText(descriptionKo || '', lang)
      ]);
      translations[lang] = { summary, description };
    }
    res.json({ success: true, translations });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.listen(PORT, () => { console.log(`Kotreet Scraper running on port ${PORT}`); });
