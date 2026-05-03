// background.js
// 支持三种模式 + 性能优化 + 调试模式 + 统计 + MySQL 缓存 + 翻译后处理
importScripts('crypto-utils.js', 'postprocess.js');

const imageCache = new Map();
const pendingRequests = new Map();
const MAX_CACHE_SIZE = 100;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'translateImage') {
    handleImageTranslation(request.imgUrl, sender.tab?.id)
      .then(result => sendResponse({ success: true, text: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'openOptionsPage') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'captureAndTranslate') {
    handleCaptureAndTranslate(request.tabId)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'autoCaptureAndTranslate') {
    handleCaptureAndTranslate(sender.tab.id)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

async function handleCaptureAndTranslate(tabId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  const translation = await handleImageTranslation(dataUrl, tabId);
  await chrome.tabs.sendMessage(tabId, {
    action: 'showCaptureTranslation',
    imageData: dataUrl,
    translation: translation
  });
}

async function handleImageTranslation(imgUrl, tabId) {
  const { devMode } = await chrome.storage.sync.get('devMode');
  if (devMode) {
    console.log('[DEBUG] 使用模拟翻译结果');
    return {
      type: 'multi',
      items: [
        { text: 'こんにちは', bbox: [0.1, 0.1, 0.4, 0.3], direction: 'horizontal' },
        { text: 'さようなら', bbox: [0.6, 0.6, 0.9, 0.8], direction: 'vertical' }
      ]
    };
  }

  let cacheKey = imgUrl;
  if (imgUrl.startsWith('data:')) {
    cacheKey = 'data-' + imgUrl.slice(-64);
  }

  if (imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey);
  }

  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  const requestPromise = (async () => {
    const startTime = Date.now();
    try {
      const config = await chrome.storage.sync.get([
        'apiKey', 'model', 'targetLang', 'prompt', 'apiEndpoint',
        'translationMode', 'ocrApiKey', 'translateModel', 'maxTokens',
        'ocrApiEndpoint', 'ocrModel', 'translateApiEndpoint', 'translateApiKey',
        'imageMaxDimension',
        'rerankOcrApiEndpoint', 'rerankOcrApiKey', 'rerankOcrModel',
        'rerankApiEndpoint', 'rerankApiKey', 'rerankModel',
        'rerankTranslateApiEndpoint', 'rerankTranslateApiKey', 'rerankTranslateModel',
        'ocrTranslatePrompt', 'rerankTranslatePrompt',
        'ocrVisionPrompt',
        'cacheApiUrl', 'cacheApiKey'
      ]);

      const maxTokens = config.maxTokens || 1000;
      const imageMaxDimension = config.imageMaxDimension || 1024;

      let base64 = await downloadImageAsBase64(imgUrl);
      base64 = await resizeBase64Image(base64, imageMaxDimension);

      let translation;
      const mode = config.translationMode;

      if (mode === 'vision') {
        const { apiKey, model, apiEndpoint } = config;
        if (!apiKey || !model || !apiEndpoint) {
          throw new Error('视觉模式需要填写 API Key、模型和端点');
        }
        const prompt = (config.prompt || '').replace('{{language}}', config.targetLang || '中文');
        translation = await translateViaVision(apiEndpoint, apiKey, model, prompt, base64, maxTokens);
      } else if (mode === 'ocr') {
        translation = await translateViaOCR(config, base64, maxTokens);
      } else if (mode === 'rerank') {
        translation = await translateViaRerank(config, base64, maxTokens);
      } else {
        throw new Error('未知的翻译模式');
      }

      const total = translation.type === 'multi' ? translation.items.length : 1;
      await recordTranslation(total, total, mode, Date.now() - startTime);

      if (imageCache.size >= MAX_CACHE_SIZE) {
        const firstKey = imageCache.keys().next().value;
        imageCache.delete(firstKey);
      }
      imageCache.set(cacheKey, translation);
      return translation;
    } catch (error) {
      const config = await chrome.storage.sync.get(['translationMode']);
      await recordTranslation(1, 0, config.translationMode || 'vision', Date.now() - startTime);
      throw error;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

// ===================== 翻译模式子函数 =====================
async function translateViaVision(endpoint, apiKey, model, prompt, imageBase64, maxTokens) {
  const payload = {
    model,
    messages: [{
      role: "user",
      content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageBase64 } }]
    }],
    max_tokens: maxTokens
  };

  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('API 返回内容为空');

  try {
    const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.every(item => item.text && item.bbox)) {
      return { type: 'multi', items: parsed };
    }
  } catch (e) { console.warn('视觉模式 JSON 解析失败，回退为单文本'); }

  return { type: 'single', text: content };
}

async function translateViaOCR(config, base64, maxTokens) {
  const ocrEndpoint = config.ocrApiEndpoint;
  if (!ocrEndpoint) throw new Error('OCR 模式需要填写 OCR API 端点');
  const ocrModel = config.ocrModel || 'TEXT_DETECTION';
  const ocrApiKey = config.ocrApiKey;

  let ocrResult;
  if (ocrEndpoint.includes('googleapis.com')) {
    ocrResult = await callGoogleVisionOCR(base64, ocrEndpoint, ocrApiKey, ocrModel);
  } else {
    if (!ocrApiKey) throw new Error('使用视觉模型 OCR 需要提供 API 密钥');
    ocrResult = await callVisionForOCR(base64, ocrEndpoint, ocrApiKey, ocrModel, maxTokens, config.ocrVisionPrompt);
  }

  if (!ocrResult.length) return { type: 'single', text: '未检测到文字' };

  const translateEndpoint = config.translateApiEndpoint;
  if (translateEndpoint) {
    const translateApiKey = config.translateApiKey;
    const translateModel = config.translateModel;
    if (!translateApiKey || !translateModel) throw new Error('翻译端点需要填写 API 密钥和模型名称');
    const ocrTranslatePrompt = config.ocrTranslatePrompt || null;
    const translatedItems = await translateTextItems(
      ocrResult, config.targetLang, translateApiKey, translateModel,
      maxTokens, translateEndpoint, ocrTranslatePrompt
    );
    return { type: 'multi', items: translatedItems };
  } else {
    return { type: 'multi', items: ocrResult };
  }
}

async function translateViaRerank(config, base64, maxTokens) {
  const ocrEndpoint = config.rerankOcrApiEndpoint;
  const ocrApiKey = config.rerankOcrApiKey;
  const ocrModel = config.rerankOcrModel || 'TEXT_DETECTION';
  if (!ocrEndpoint || !ocrApiKey) throw new Error('重排序模式缺少 OCR 配置');

  let ocrResult;
  if (ocrEndpoint.includes('googleapis.com')) {
    ocrResult = await callGoogleVisionOCR(base64, ocrEndpoint, ocrApiKey, ocrModel);
  } else {
    ocrResult = await callVisionForOCR(base64, ocrEndpoint, ocrApiKey, ocrModel, maxTokens, config.ocrVisionPrompt);
  }

  if (!ocrResult.length) return { type: 'single', text: '未检测到文字' };

  const rerankEndpoint = config.rerankApiEndpoint;
  const rerankApiKey = config.rerankApiKey;
  const rerankModel = config.rerankModel;
  if (!rerankEndpoint || !rerankApiKey || !rerankModel) throw new Error('重排序模式缺少重排序配置');
  const sortedItems = await rerankTextItems(ocrResult, base64, rerankEndpoint, rerankApiKey, rerankModel, maxTokens);

  const translateEndpoint = config.rerankTranslateApiEndpoint;
  const translateApiKey = config.rerankTranslateApiKey;
  const translateModel = config.rerankTranslateModel;
  if (!translateEndpoint || !translateApiKey || !translateModel) throw new Error('重排序模式缺少翻译配置');
  const rerankTranslatePrompt = config.rerankTranslatePrompt || null;
  const translatedItems = await translateTextItems(
    sortedItems, config.targetLang, translateApiKey, translateModel,
    maxTokens, translateEndpoint, rerankTranslatePrompt
  );
  return { type: 'multi', items: translatedItems };
}

// ===================== 通用工具函数 =====================
async function downloadImageAsBase64(url) {
  if (url.startsWith('data:')) return url;
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`图片下载失败: ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64) {
  const arr = base64.split(',');
  const mime = arr[0].match(/:(.*?);/)[1] || 'image/png';
  const bstr = atob(arr[1]);
  const u8arr = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
  return new Blob([u8arr], { type: mime });
}

async function resizeBase64Image(base64, maxDimension) {
  const blob = base64ToBlob(base64);
  const bitmap = await createImageBitmap(blob);
  let width = bitmap.width, height = bitmap.height;
  if (width > maxDimension || height > maxDimension) {
    if (width > height) {
      height = Math.round(height * maxDimension / width);
      width = maxDimension;
    } else {
      width = Math.round(width * maxDimension / height);
      height = maxDimension;
    }
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blobOut = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blobOut);
  });
}

async function getBase64ImageSize(base64) {
  const blob = base64ToBlob(base64);
  const bitmap = await createImageBitmap(blob);
  return { width: bitmap.width, height: bitmap.height };
}

async function fetchWithRetry(url, options, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return res;
    } catch (err) {
      if (i === retries) throw err;
      console.warn(`第 ${i + 1} 次重试...`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// ===================== OCR 调用 =====================
async function callGoogleVisionOCR(base64, endpoint, apiKey, model) {
  const content = base64.split(',')[1];
  const body = { requests: [{ image: { content }, features: [{ type: model || 'TEXT_DETECTION', maxResults: 50 }] }] };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && !endpoint.includes('googleapis.com')) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetchWithRetry(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json();
  const annotations = data.responses?.[0]?.textAnnotations;
  if (!annotations?.length) return [];

  const items = [];
  const imgSize = await getBase64ImageSize(base64);
  for (let i = 1; i < annotations.length; i++) {
    const ann = annotations[i];
    const v = ann.boundingPoly.vertices;
    if (v.length < 4) continue;
    items.push({
      text: ann.description,
      bbox: [v[0].x / imgSize.width, v[0].y / imgSize.height, v[2].x / imgSize.width, v[2].y / imgSize.height]
    });
  }
  return items;
}

// 替换 background.js 中的 callVisionForOCR 函数
async function callVisionForOCR(base64, endpoint, apiKey, model, maxTokens, userPrompt) {
  const defaultPrompt = `Detect all text regions in this image.
Return a strict JSON array: [{"text": "string", "bbox": [x1, y1, x2, y2]}, ...].
Coordinates must be normalized (0.0 to 1.0), with x1<x2 and y1<y2.
Output only the JSON array, no other text.`;
  const prompt = userPrompt || defaultPrompt;

  const payload = {
    model: model || 'gpt-4o-mini',
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: base64 } }
      ]
    }],
    max_tokens: maxTokens,
    temperature: 0
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('视觉 OCR 请求网络错误:', err);
    return []; // 网络错误，返回空数组
  }

  if (!response.ok) {
    const errText = await response.text();
    console.error('视觉 OCR API 返回错误:', response.status, errText);
    return [];
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content;
  if (!content) {
    console.error('视觉 OCR API 返回内容为空');
    return [];
  }

  console.log('📥 视觉模型原始返回:', content);
  const imgSize = await getBase64ImageSize(base64);

  // 1. 尝试提取 JSON 数组
  let jsonStr = null;
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1];
  } else {
    const firstBracket = content.indexOf('[');
    const lastBracket = content.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      jsonStr = content.substring(firstBracket, lastBracket + 1);
    }
  }

  // 2. 如果找不到 JSON 数组，将整个内容当作单文本返回
  if (!jsonStr) {
    console.warn('未找到 JSON 数组，将原始文本作为单文本翻译');
    return [{ text: content.trim(), bbox: [0, 0, 1, 1] }];
  }

  // 3. 修复常见 JSON 错误
  jsonStr = jsonStr
    .replace(/,\s*]/g, ']')           // 移除数组尾部逗号
    .replace(/,\s*}/g, '}')           // 移除对象尾部逗号
    .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3') // 属性名加引号
    .replace(/'/g, '"')               // 单引号替换（谨慎）
    .trim();

  // 4. 尝试解析
  try {
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed)) {
      const items = parsed
        .filter(item => item.text && Array.isArray(item.bbox) && item.bbox.length === 4)
        .map(item => {
          let bbox = item.bbox.map(Number);
          const maxCoord = Math.max(...bbox);
          if (maxCoord > 1 && imgSize.width > 0 && imgSize.height > 0) {
            bbox = [
              bbox[0] / imgSize.width,
              bbox[1] / imgSize.height,
              bbox[2] / imgSize.width,
              bbox[3] / imgSize.height
            ];
          }
          return { text: item.text, bbox };
        });
      if (items.length > 0) {
        console.log('✅ 成功解析文字区域数量:', items.length);
        return items;
      }
    }
  } catch (e) {
    console.error('❌ JSON 解析失败:', e.message);
    console.error('原始修复后 JSON:', jsonStr);
  }

  // 5. 最终降级：尝试用正则提取所有类似 "text":"xxx" 的文本片段
  const textMatches = content.match(/"text"\s*:\s*"([^"]+)"/g) || content.match(/text['"]?\s*:\s*['"]([^'"]+)['"]/g);
  if (textMatches) {
    const extracted = textMatches.map(s => s.replace(/.*:\s*["']/, '').replace(/["']$/, ''));
    console.warn('⚠️ 使用正则提取文本片段:', extracted);
    return extracted.map(t => ({ text: t, bbox: [0, 0, 1, 1] }));
  }

  // 6. 完全失败：返回整个原始文本
  console.error('无法从 OCR 结果中提取任何文字');
  return [];
}

async function rerankTextItems(items, base64, endpoint, apiKey, model, maxTokens) {
  const prompt = `Sort these texts in comic reading order: ${JSON.stringify(items.map(i => i.text))}. Output only a JSON string array.`;
  const payload = {
    model,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: base64 } }] }],
    max_tokens, temperature: 0
  };
  const res = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  try {
    const sorted = JSON.parse(content.replace(/```/g, '').trim());
    const map = new Map(items.map(i => [i.text, i]));
    return sorted.map(t => map.get(t)).filter(Boolean);
  } catch { return items; }
}

// ===================== 翻译文本（整合缓存 + 后处理） =====================
async function translateTextItems(items, targetLang, apiKey, model, maxTokens, endpoint, systemPrompt) {
  if (!items.length) return [];

  const { cacheApiUrl, cacheApiKey } = await chrome.storage.sync.get(['cacheApiUrl', 'cacheApiKey']);
  const cacheResults = cacheApiUrl ? await checkCacheBatch(items, targetLang, cacheApiUrl, cacheApiKey) : {};

  const uncached = [];
  const cached = [];
  for (const item of items) {
    const key = `${item.text}::${targetLang}`;
    if (cacheResults[key]) {
      cached.push({ ...item, text: cacheResults[key], originalText: item.text });
    } else {
      uncached.push(item);
    }
  }

  const defaultPrompt = `You are a translator. Translate the following text into ${targetLang}. Return only the translated text.`;
  const finalPrompt = systemPrompt || defaultPrompt;

  const freshTranslated = [];
  if (uncached.length) {
    const translated = await Promise.all(uncached.map(async item => {
      const res = await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: finalPrompt }, { role: 'user', content: item.text }], max_tokens: maxTokens })
      });
      const data = await res.json();
      const textOut = data.choices[0].message.content.trim();
      return { ...item, text: textOut, originalText: item.text };
    }));
    freshTranslated.push(...translated);

    saveToCacheBatch(freshTranslated, targetLang, cacheApiUrl, cacheApiKey);
  }

  const resultMap = new Map();
  cached.forEach(i => resultMap.set(i.text, i));
  freshTranslated.forEach(i => resultMap.set(i.originalText, i));
  let finalItems = items.map(item => resultMap.get(item.text) || item);

  // 翻译后处理（拟声词、繁简转换等）
  finalItems = postProcessItems(finalItems, targetLang);

  return finalItems;
}

// ===================== 缓存 API 通信 =====================
async function checkCacheBatch(items, targetLang, apiUrl, apiKey) {
  const url = apiUrl.replace(/\/$/, '') + '/cache/batch_get';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(items.map(i => ({ source_text: i.text, target_lang: targetLang })))
    });
    if (!res.ok) return {};
    const data = await res.json();
    return data.results || {};
  } catch (e) { console.warn('缓存查询失败', e.message); return {}; }
}

async function saveToCacheBatch(items, targetLang, apiUrl, apiKey) {
  if (!apiUrl || !items.length) return;
  const url = apiUrl.replace(/\/$/, '') + '/cache/batch_set';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ items: items.map(i => ({ source_text: i.originalText, target_lang: targetLang, translated_text: i.text })) })
  }).catch(e => console.warn('缓存存储失败', e.message));
}

// ===================== 统计 =====================
const statsStorageKey = 'translationStats';
async function getStats() {
  const { [statsStorageKey]: stats } = await chrome.storage.local.get(statsStorageKey);
  return stats || { totalImages: 0, totalSuccess: 0, totalFail: 0, totalDuration: 0, modes: { vision: {}, ocr: {}, rerank: {} } };
}
async function recordTranslation(count, success, mode, duration) {
  const stats = await getStats();
  stats.totalImages += count;
  stats.totalSuccess += success;
  stats.totalFail += count - success;
  stats.totalDuration = (stats.totalDuration || 0) + duration;
  if (!stats.modes[mode]) stats.modes[mode] = { count: 0, success: 0 };
  stats.modes[mode].count += count;
  stats.modes[mode].success += success;
  await chrome.storage.local.set({ [statsStorageKey]: stats });
}