require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS 설정 (Kotreet 도메인만 허용)
app.use(cors({
  origin: ['https://kotreet.com', 'http://localhost:3000'],
  methods: ['POST', 'GET'],
}));
app.use(express.json());

// Gemini AI 초기화
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 불용어 제거 (토큰 절약)
const removeStopwords = (text) => {
  const stopwords = ['이', '가', '을', '를', '은', '는', '에', '의', '로', '와', '과', '도', '만', '에서', '으로', '하고', '그리고', '또한', '그런데', '하지만', '그래서', '그러나', '또', '더', '매우', '정말', '진짜', '너무', '아주', '굉장히', '엄청', '완전', 'ㅋㅋ', 'ㅎㅎ', 'ㅠㅠ', 'ㅜㅜ', '...', '..', '!', '?', '~'];
  let cleaned = text;
  stopwords.forEach(word => {
    cleaned = cleaned.replace(new RegExp(word, 'g'), ' ');
  });
  return cleaned.replace(/\s+/g, ' ').trim();
};

// 카테고리별 프롬프트
const getCategoryPrompt = (category, indicators) => {
  const basePrompt = `You are an expert reviewer analyzing Korean ${category} for foreign tourists.
Based on the reviews provided, evaluate the following 10 indicators on a scale of 1-10:

${indicators.map((ind, i) => `${i + 1}. ${ind}`).join('\n')}

Also provide:
- A confidence score (1-10) for your analysis
- A one-line summary in English targeting foreign tourists (max 100 chars)
- A one-line summary in Korean (max 50 chars)

Response format (JSON only, no markdown):
{
  "scores": [score1, score2, ..., score10],
  "confidence": number,
  "summaryEn": "string",
  "summaryKo": "string"
}`;

  return basePrompt;
};

// 헬스체크
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Kotreet Scraper API' });
});

// 네이버 리뷰 스크래핑
app.post('/api/scrape/naver', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // 네이버 플레이스 검색
    const searchUrl = `https://m.place.naver.com/search/${encodeURIComponent(shopName)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
    
    // 첫 번째 결과 클릭
    await page.waitForSelector('a[href*="/restaurant/"], a[href*="/cafe/"], a[href*="/hairshop/"]', { timeout: 10000 });
    const firstResult = await page.$('a[href*="/restaurant/"], a[href*="/cafe/"], a[href*="/hairshop/"]');
    if (firstResult) {
      await firstResult.click();
      await page.waitForLoadState('networkidle');
    }

    // 리뷰 탭 이동
    await page.click('text=리뷰');
    await page.waitForTimeout(2000);

    // 리뷰 텍스트 수집
    const reviews = await page.$$eval('.pui__vn15t2 span, .pui__xtsQN-', elements => 
      elements.slice(0, 30).map(el => el.textContent?.trim()).filter(Boolean)
    );

    await browser.close();
    
    const combinedText = reviews.join(' ').slice(0, 8000); // 토큰 제한
    res.json({ 
      success: true, 
      reviews: reviews.slice(0, 30),
      combinedText: removeStopwords(combinedText),
      source: 'naver'
    });

  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ error: error.message, source: 'naver' });
  }
});

// 구글 리뷰 스크래핑
app.post('/api/scrape/google', async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // 구글맵 검색
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(shopName + ' 서울')}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
    
    // 첫 번째 결과 클릭
    await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 10000 });
    const firstResult = await page.$('a[href*="/maps/place/"]');
    if (firstResult) {
      await firstResult.click();
      await page.waitForLoadState('networkidle');
    }

    // 리뷰 버튼 클릭
    await page.waitForTimeout(2000);
    const reviewBtn = await page.$('button[aria-label*="리뷰"], button[aria-label*="review"]');
    if (reviewBtn) {
      await reviewBtn.click();
      await page.waitForTimeout(2000);
    }

    // 리뷰 텍스트 수집
    const reviews = await page.$$eval('.wiI7pd, .MyEned', elements => 
      elements.slice(0, 30).map(el => el.textContent?.trim()).filter(Boolean)
    );

    await browser.close();
    
    const combinedText = reviews.join(' ').slice(0, 8000);
    res.json({ 
      success: true, 
      reviews: reviews.slice(0, 30),
      combinedText: removeStopwords(combinedText),
      source: 'google'
    });

  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ error: error.message, source: 'google' });
  }
});

// AI 분석 (Gemini)
app.post('/api/analyze', async (req, res) => {
  const { reviewText, category, indicators } = req.body;
  
  if (!reviewText || !category || !indicators || indicators.length !== 10) {
    return res.status(400).json({ error: 'reviewText, category, and 10 indicators required' });
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = getCategoryPrompt(category, indicators);
    
    const result = await model.generateContent([
      prompt,
      `\n\nReviews to analyze:\n${reviewText.slice(0, 6000)}`
    ]);
    
    const responseText = result.response.text();
    
    // JSON 파싱 (마크다운 코드블록 제거)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Invalid AI response format');
    }
    
    const analysis = JSON.parse(jsonMatch[0]);
    
    res.json({
      success: true,
      analysis: {
        scores: analysis.scores,
        confidence: analysis.confidence,
        summaryEn: analysis.summaryEn,
        summaryKo: analysis.summaryKo,
        indicators: indicators
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 재분석 (피드백 반영)
app.post('/api/reanalyze', async (req, res) => {
  const { reviewText, category, indicators, previousAnalysis, feedback } = req.body;
  
  if (!reviewText || !feedback) {
    return res.status(400).json({ error: 'reviewText and feedback required' });
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `${getCategoryPrompt(category, indicators)}

Previous analysis result:
${JSON.stringify(previousAnalysis, null, 2)}

User feedback for re-analysis:
${feedback}

Please re-analyze considering the feedback above.`;
    
    const result = await model.generateContent([
      prompt,
      `\n\nReviews:\n${reviewText.slice(0, 6000)}`
    ]);
    
    const responseText = result.response.text();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid AI response format');
    
    const analysis = JSON.parse(jsonMatch[0]);
    
    res.json({
      success: true,
      analysis: {
        scores: analysis.scores,
        confidence: analysis.confidence,
        summaryEn: analysis.summaryEn,
        summaryKo: analysis.summaryKo,
        indicators: indicators
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 수동 리뷰 입력 + 분석 (스크래핑 없이)
app.post('/api/analyze-manual', async (req, res) => {
  const { reviewText, category, indicators } = req.body;
  
  if (!reviewText || !category || !indicators || indicators.length !== 10) {
    return res.status(400).json({ error: 'reviewText, category, and 10 indicators required' });
  }

  try {
    const cleanedText = removeStopwords(reviewText);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = getCategoryPrompt(category, indicators);
    
    const result = await model.generateContent([
      prompt,
      `\n\nReviews to analyze:\n${cleanedText.slice(0, 6000)}`
    ]);
    
    const responseText = result.response.text();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid AI response format');
    
    const analysis = JSON.parse(jsonMatch[0]);
    
    res.json({
      success: true,
      analysis: {
        scores: analysis.scores,
        confidence: analysis.confidence,
        summaryEn: analysis.summaryEn,
        summaryKo: analysis.summaryKo,
        indicators: indicators
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Kotreet Scraper running on port ${PORT}`);
});
