// adapters/deepl.js
// ========================================================================
//  DeepL 翻译 API 适配器
// ========================================================================
//
//  功能：调用 DeepL 翻译 API（免费版或 Pro 版），将单个文本翻译为目标语言。
//  适用场景：当用户配置的翻译端点指向 DeepL 时，background.js 会使用此适配器。
//
//  使用方法：
//    1. 在 background.js 中通过 importScripts('adapters/deepl.js') 导入。
//    2. 在 translateTextItems 中判断端点类型，若包含 "deepl" 则调用此模块。
//       (也可根据用户配置独立字段，此处提供函数供调用)
//
//  前置条件：
//    - 拥有 DeepL API 密钥（免费版或 Pro 版）。
//    - 已在选项页配置翻译端点或 API 密钥（本适配器可独立使用密钥）。
//
//  参考文档：https://www.deepl.com/docs-api
// ========================================================================

/**
 * 将单条文本通过 DeepL API 翻译为目标语言
 * 
 * @param {string} text - 待翻译的原文（支持多种语言）
 * @param {string} targetLang - 目标语言代码，如 "ZH"（简体中文）、"EN-US"（美式英语）
 * @param {string} apiKey - DeepL 认证密钥（提交到 Authorization 头）
 * @param {string} endpoint - DeepL API 端点，默认为免费版端点
 * @returns {Promise<string>} 返回翻译后的文本字符串。若翻译失败，返回原文作为降级策略。
 * 
 * @throws 不会主动抛出异常，失败时返回原文。
 *
 * 示例：
 *   const result = await translateWithDeepL("こんにちは", "ZH", "your-auth-key");
 *   // result: "你好"
 * 
 * 注意：
 *   - 免费版端点：https://api-free.deepl.com/v2/translate
 *   - Pro 版端点：   https://api.deepl.com/v2/translate
 *   - 目标语言格式：DeepL 使用大写语言代码（如 EN、DE、ZH），
 *     本函数内部会自动将常见小写代码（如 "zh"、"en"）转换为大写。
 *     如果需要地区限定（如 "EN-US"），请直接传入。
 */
async function translateWithDeepL(text, targetLang, apiKey, endpoint = 'https://api-free.deepl.com/v2/translate') {
  // 将目标语言转为大写以符合 DeepL 要求，但保留连字符形式（如 EN-US）
  const normalizedLang = targetLang.includes('-') 
    ? targetLang.toUpperCase() 
    : targetLang.toUpperCase().split('-')[0];
  
  // 构建请求体（application/x-www-form-urlencoded 格式）
  const params = new URLSearchParams();
  params.append('text', text);
  params.append('target_lang', normalizedLang);
  
  const headers = {
    'Authorization': `DeepL-Auth-Key ${apiKey}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: params
    });

    // 检查 HTTP 状态码
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`DeepL API 请求失败 (${response.status}): ${errorText}`);
      // 降级策略：返回原文
      return text;
    }

    const data = await response.json();
    
    // DeepL 响应结构：
    // { "translations": [ { "detected_source_language": "JA", "text": "你好" } ] }
    if (data.translations && data.translations.length > 0) {
      const translatedText = data.translations[0].text;
      console.log(`DeepL 翻译成功: "${text}" → "${translatedText}"`);
      return translatedText;
    } else {
      console.warn('DeepL 返回格式异常，降级为原文');
      return text;
    }
  } catch (error) {
    // 网络异常或其他错误，降级返回原文
    console.error('DeepL 网络请求异常:', error.message);
    return text;
  }
}

/**
 * 批量翻译文本数组（逐条调用 DeepL）
 * 
 * 注意：DeepL 支持一次请求翻译多条文本，只需在请求体中包含多个 text 参数即可。
 * 但为避免 API 调用复杂度，此处采用逐条调用。如需要高性能，可改造为单次请求发送多条。
 *
 * @param {Array<{text: string}>} items - 待翻译文本项数组
 * @param {string} targetLang - 目标语言代码
 * @param {string} apiKey - DeepL 认证密钥
 * @param {string} endpoint - DeepL API 端点（可选）
 * @returns {Promise<Array<{text: string}>>} 翻译后的文本项数组
 */
async function translateBatchWithDeepL(items, targetLang, apiKey, endpoint = 'https://api-free.deepl.com/v2/translate') {
  if (!items || items.length === 0) return [];

  // 逐条翻译
  const results = await Promise.all(
    items.map(async (item) => {
      const translatedText = await translateWithDeepL(
        item.text,
        targetLang,
        apiKey,
        endpoint
      );
      return {
        ...item,
        text: translatedText,
        originalText: item.text  // 保留原文，用于缓存存储
      };
    })
  );
  
  return results;
}

/**
 * 检测端点是否为 DeepL API
 * 用于 background.js 中判断使用哪个适配器
 * 
 * @param {string} endpoint - 用户配置的翻译 API 端点
 * @returns {boolean} 是否为 DeepL 端点
 */
function isDeepLEndpoint(endpoint) {
  return endpoint && (endpoint.includes('deepl.com') || endpoint.includes('api-free.deepl.com'));
}

// ---------- 调试与自测代码（注释掉，仅开发时使用） ----------
/*
(async () => {
  const testKey = 'your-deepl-auth-key';
  const testText = 'おはようございます';
  const result = await translateWithDeepL(testText, 'EN', testKey);
  console.log('DeepL 测试结果:', result);
})();
*/