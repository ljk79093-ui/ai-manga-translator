// adapters/azure.js
/**
 * Azure Translator Text API 适配器
 * 
 * 功能：调用微软 Azure 认知服务的翻译接口，将单个文本翻译为目标语言。
 * 适用场景：当用户配置的翻译端点指向 Azure 时，background.js 会优先使用此适配器。
 * 
 * 使用方法：
 *   1. 在 background.js 中通过 importScripts('adapters/azure.js') 导入
 *   2. 在 translateTextItems 中判断端点类型，调用 translateWithAzure()
 * 
 * 前置条件：
 *   - 拥有 Azure 订阅，并已创建 Translator 资源
 *   - 获取了订阅密钥 (apiKey) 和区域 (region)
 *   - 已在 options 页面填写对应配置
 */

/**
 * 将单条文本通过 Azure Translator API 翻译为目标语言
 * 
 * @param {string} text - 待翻译的原文（通常为日语、英语等）
 * @param {string} targetLang - 目标语言代码，如 "zh-Hans"（简体中文）、"en"（英语）
 * @param {string} apiKey - Azure 门户中获取的订阅密钥
 * @param {string} region - Azure Translator 资源的区域，如 "eastasia"、"global"
 * @returns {Promise<string>} 返回翻译后的文本字符串。如果翻译失败，返回原文作为降级策略
 * 
 * @throws {Error} 当网络错误或 API 返回非 2xx 状态时抛出，但内部会捕获并降级
 * 
 * 示例：
 *   const result = await translateWithAzure("こんにちは", "zh-Hans", "your-key", "eastasia");
 *   // result: "你好"
 * 
 * API 文档参考：
 *   https://learn.microsoft.com/zh-cn/azure/cognitive-services/translator/reference/v3-0-translate
 */
async function translateWithAzure(text, targetLang, apiKey, region) {
  // 构建请求 URL：API 版本 3.0，目标语言通过 to 参数指定
  const baseUrl = 'https://api.cognitive.microsofttranslator.com/translate';
  const params = new URLSearchParams({
    'api-version': '3.0',
    'to': targetLang,               // 目标语言，如 "zh-Hans"
    'textType': 'plain'             // 纯文本模式，避免 HTML 解析
  });
  const url = `${baseUrl}?${params.toString()}`;

  // 设置请求头：密钥和区域必须在 headers 中提供
  const headers = {
    'Ocp-Apim-Subscription-Key': apiKey,   // Azure 订阅密钥
    'Ocp-Apim-Subscription-Region': region, // 资源区域
    'Content-Type': 'application/json'
  };

  // 请求体格式：文档数组，每个元素包含 Text 字段
  const body = JSON.stringify([{ Text: text }]);

  try {
    // 发起 HTTP POST 请求
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: body
    });

    // 检查 HTTP 状态码，非 2xx 视为失败
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Azure Translator 请求失败 (${response.status}): ${errorText}`);
      // 降级策略：返回原文，确保不影响用户阅读
      return text;
    }

    // 解析 JSON 响应
    const data = await response.json();

    // 响应结构：数组 → translations 数组 → text 字段
    // 示例数据：
    // [ { "translations": [ { "text": "你好", "to": "zh-Hans" } ] } ]
    if (data && data.length > 0 && data[0].translations && data[0].translations.length > 0) {
      const translatedText = data[0].translations[0].text;
      console.log(`Azure 翻译成功: "${text}" → "${translatedText}"`);
      return translatedText;
    } else {
      // 响应格式异常，降级返回原文
      console.warn('Azure Translator 返回格式异常，降级为原文');
      return text;
    }
  } catch (error) {
    // 网络异常或其他错误，降级返回原文
    console.error('Azure Translator 网络请求异常:', error.message);
    return text;
  }
}

/**
 * 批量翻译文本数组（封装 translateWithAzure 的批量调用）
 * 
 * 注意：Azure Translator 支持一次请求翻译多条文本，但此处为了
 * 保持与现有 translateTextItems 接口一致，采用逐条调用方式。
 * 如需优化性能，可改为单次请求传入多个 Text 对象。
 * 
 * @param {Array<{text: string}>} items - 待翻译文本项数组
 * @param {string} targetLang - 目标语言代码
 * @param {string} apiKey - Azure 订阅密钥
 * @param {string} region - Azure 资源区域
 * @returns {Promise<Array<{text: string}>>} 翻译后的文本项数组
 */
async function translateBatchWithAzure(items, targetLang, apiKey, region) {
  if (!items || items.length === 0) return [];

  // 逐条翻译（如需优化，可将所有文本合并到一次 API 调用中）
  const results = await Promise.all(
    items.map(async (item) => {
      const translatedText = await translateWithAzure(
        item.text,
        targetLang,
        apiKey,
        region
      );
      // 返回包含原文和译文的新对象
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
 * 检测端点是否为 Azure Translator API
 * 用于 background.js 中自动判断使用哪个适配器
 * 
 * @param {string} endpoint - 用户配置的翻译 API 端点
 * @returns {boolean} 是否为 Azure 端点
 */
function isAzureEndpoint(endpoint) {
  return endpoint && endpoint.includes('cognitive.microsofttranslator.com');
}

// ---------- 调试与自测代码（注释掉，仅开发时使用） ----------
/*
(async () => {
  const testKey = 'your-test-key';
  const testRegion = 'eastasia';
  const testText = 'おはようございます';
  const result = await translateWithAzure(testText, 'en', testKey, testRegion);
  console.log('测试结果:', result);
})();
*/