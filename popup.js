// popup.js
// 自动保存 + 后处理开关 + 气泡排版样式

document.addEventListener('DOMContentLoaded', async () => {
  // ---------- 读取配置 ----------
  const result = await chrome.storage.sync.get([
    'apiKey', 'model', 'targetLang', 'prompt', 'apiEndpoint',
    'floatIconUrl', 'floatIconWidth', 'floatIconHeight',
    'maxConcurrent', 'translationMode', 'ocrApiKey', 'translateModel',
    'ocrApiEndpoint', 'ocrModel', 'translateApiEndpoint', 'translateApiKey',
    'imageMaxDimension', 'maxTokens', 'floatButtonEnabled',
    'rerankOcrApiEndpoint', 'rerankOcrApiKey', 'rerankOcrModel',
    'rerankApiEndpoint', 'rerankApiKey', 'rerankModel',
    'rerankTranslateApiEndpoint', 'rerankTranslateApiKey', 'rerankTranslateModel',
    'ocrTranslatePrompt', 'rerankTranslatePrompt',
    'ocrVisionPrompt',
    'enablePostprocess', 'bubblePreset'  // 新增
  ]);

  // ---------- 填充默认值 ----------
  document.getElementById('targetLang').value = result.targetLang || '中文';
  document.getElementById('prompt').value = result.prompt || 
    '你是一个漫画翻译助手。请将这幅漫画中所有文字翻译成{{language}}。如果图片中没有文字，请返回“无文字”。只返回翻译后的文本，不要额外解释。';
  document.getElementById('floatIconUrl').value = result.floatIconUrl || '';
  document.getElementById('floatIconWidth').value = result.floatIconWidth || '48';
  document.getElementById('floatIconHeight').value = result.floatIconHeight || '48';
  document.getElementById('maxConcurrent').value = result.maxConcurrent || '3';
  document.getElementById('imageMaxDimension').value = result.imageMaxDimension || '1024';
  document.getElementById('maxTokens').value = result.maxTokens || '1000';
  document.getElementById('floatButtonEnabled').checked = result.floatButtonEnabled !== false;

  document.getElementById('translationMode').value = result.translationMode || 'vision';

  // 视觉模式
  document.getElementById('apiKey').value = result.apiKey || '';
  document.getElementById('model').value = result.model || '';
  document.getElementById('apiEndpoint').value = result.apiEndpoint || '';

  // OCR 模式
  document.getElementById('ocrApiEndpoint').value = result.ocrApiEndpoint || '';
  document.getElementById('ocrApiKey').value = result.ocrApiKey || '';
  document.getElementById('ocrModel').value = result.ocrModel || 'TEXT_DETECTION';
  document.getElementById('translateApiEndpoint').value = result.translateApiEndpoint || '';
  document.getElementById('translateApiKey').value = result.translateApiKey || '';
  document.getElementById('translateModel').value = result.translateModel || '';
  document.getElementById('ocrTranslatePrompt').value = result.ocrTranslatePrompt || '';
  document.getElementById('ocrVisionPrompt').value = result.ocrVisionPrompt || '';

  // 重排序模式
  document.getElementById('rerankOcrApiEndpoint').value = result.rerankOcrApiEndpoint || '';
  document.getElementById('rerankOcrApiKey').value = result.rerankOcrApiKey || '';
  document.getElementById('rerankOcrModel').value = result.rerankOcrModel || 'TEXT_DETECTION';
  document.getElementById('rerankApiEndpoint').value = result.rerankApiEndpoint || '';
  document.getElementById('rerankApiKey').value = result.rerankApiKey || '';
  document.getElementById('rerankModel').value = result.rerankModel || '';
  document.getElementById('rerankTranslateApiEndpoint').value = result.rerankTranslateApiEndpoint || '';
  document.getElementById('rerankTranslateApiKey').value = result.rerankTranslateApiKey || '';
  document.getElementById('rerankTranslateModel').value = result.rerankTranslateModel || '';
  document.getElementById('rerankTranslatePrompt').value = result.rerankTranslatePrompt || '';

  // 新增：后处理开关、气泡预设
  document.getElementById('enablePostprocess').checked = result.enablePostprocess !== false;
  document.getElementById('bubblePreset').value = result.bubblePreset || 'mangaClassic';

  // 根据当前模式显示/隐藏设置区域
  toggleModeSettings();
  document.getElementById('translationMode').addEventListener('change', toggleModeSettings);

  // ---------- 自动保存 ----------
  function debounce(func, wait) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  }

  async function autoSave() {
    const translationMode = document.getElementById('translationMode').value;
    const targetLang = document.getElementById('targetLang').value.trim();
    const prompt = document.getElementById('prompt').value.trim();
    const floatIconUrl = document.getElementById('floatIconUrl').value.trim();
    const floatIconWidth = parseInt(document.getElementById('floatIconWidth').value) || 48;
    const floatIconHeight = parseInt(document.getElementById('floatIconHeight').value) || 48;
    const maxConcurrent = parseInt(document.getElementById('maxConcurrent').value) || 3;
    const imageMaxDimension = parseInt(document.getElementById('imageMaxDimension').value) || 1024;
    const maxTokens = parseInt(document.getElementById('maxTokens').value) || 1000;
    const floatButtonEnabled = document.getElementById('floatButtonEnabled').checked;

    const apiKey = document.getElementById('apiKey').value.trim();
    const model = document.getElementById('model').value.trim();
    const apiEndpoint = document.getElementById('apiEndpoint').value.trim();

    const ocrApiEndpoint = document.getElementById('ocrApiEndpoint').value.trim();
    const ocrApiKey = document.getElementById('ocrApiKey').value.trim();
    const ocrModel = document.getElementById('ocrModel').value.trim() || 'TEXT_DETECTION';
    const translateApiEndpoint = document.getElementById('translateApiEndpoint').value.trim();
    const translateApiKey = document.getElementById('translateApiKey').value.trim();
    const translateModel = document.getElementById('translateModel').value.trim();
    const ocrTranslatePrompt = document.getElementById('ocrTranslatePrompt').value.trim();
    const ocrVisionPrompt = document.getElementById('ocrVisionPrompt').value.trim();

    const rerankOcrApiEndpoint = document.getElementById('rerankOcrApiEndpoint').value.trim();
    const rerankOcrApiKey = document.getElementById('rerankOcrApiKey').value.trim();
    const rerankOcrModel = document.getElementById('rerankOcrModel').value.trim() || 'TEXT_DETECTION';
    const rerankApiEndpoint = document.getElementById('rerankApiEndpoint').value.trim();
    const rerankApiKey = document.getElementById('rerankApiKey').value.trim();
    const rerankModel = document.getElementById('rerankModel').value.trim();
    const rerankTranslateApiEndpoint = document.getElementById('rerankTranslateApiEndpoint').value.trim();
    const rerankTranslateApiKey = document.getElementById('rerankTranslateApiKey').value.trim();
    const rerankTranslateModel = document.getElementById('rerankTranslateModel').value.trim();
    const rerankTranslatePrompt = document.getElementById('rerankTranslatePrompt').value.trim();

    const enablePostprocess = document.getElementById('enablePostprocess').checked;
    const bubblePreset = document.getElementById('bubblePreset').value;

    await chrome.storage.sync.set({
      translationMode,
      apiKey, model, targetLang, prompt, apiEndpoint,
      ocrApiEndpoint, ocrModel, ocrApiKey,
      translateApiEndpoint, translateApiKey, translateModel,
      ocrTranslatePrompt,
      ocrVisionPrompt,
      rerankOcrApiEndpoint, rerankOcrApiKey, rerankOcrModel,
      rerankApiEndpoint, rerankApiKey, rerankModel,
      rerankTranslateApiEndpoint, rerankTranslateApiKey, rerankTranslateModel,
      rerankTranslatePrompt,
      floatIconUrl, floatIconWidth, floatIconHeight,
      maxConcurrent,
      imageMaxDimension,
      maxTokens,
      floatButtonEnabled,
      enablePostprocess,
      bubblePreset
    });
  }

  const debouncedAutoSave = debounce(autoSave, 500);

  // 为所有输入元素绑定自动保存
  const inputIds = [
    'targetLang', 'prompt', 'floatIconUrl', 'floatIconWidth', 'floatIconHeight',
    'maxConcurrent', 'imageMaxDimension', 'maxTokens', 'translationMode',
    'apiKey', 'model', 'apiEndpoint', 'ocrApiEndpoint', 'ocrApiKey',
    'ocrModel', 'translateApiEndpoint', 'translateApiKey', 'translateModel',
    'ocrTranslatePrompt', 'ocrVisionPrompt',
    'rerankOcrApiEndpoint', 'rerankOcrApiKey', 'rerankOcrModel',
    'rerankApiEndpoint', 'rerankApiKey', 'rerankModel',
    'rerankTranslateApiEndpoint', 'rerankTranslateApiKey', 'rerankTranslateModel',
    'rerankTranslatePrompt'
  ];
  inputIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', debouncedAutoSave);
      el.addEventListener('change', debouncedAutoSave);
    }
  });

  document.getElementById('floatButtonEnabled').addEventListener('change', debouncedAutoSave);
  document.getElementById('enablePostprocess').addEventListener('change', debouncedAutoSave);
  document.getElementById('bubblePreset').addEventListener('change', debouncedAutoSave);

  // ---------- 按钮事件 ----------
  document.getElementById('save').addEventListener('click', async () => {
    await autoSave();
    showStatus('✅ 设置已保存', 'success');
  });

  document.getElementById('translate').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      showStatus('❌ 未找到活动标签页', 'error');
      return;
    }
    showStatus('⏳ 正在翻译，请稍候...', 'info');
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'translatePage' });
      showStatus(response?.status || '✅ 翻译任务已开始', 'success');
    } catch (error) {
      showStatus('❌ 无法连接到页面，请刷新后重试', 'error');
    }
  });

  document.getElementById('capture').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      showStatus('❌ 未找到活动标签页', 'error');
      return;
    }
    showStatus('⏳ 正在截屏并翻译，请稍候...', 'info');
    try {
      chrome.runtime.sendMessage({ action: 'captureAndTranslate', tabId: tab.id }, (response) => {
        if (response?.success) {
          showStatus('✅ 截屏翻译完成', 'success');
        } else {
          showStatus('❌ 截屏翻译失败: ' + (response?.error || '未知错误'), 'error');
        }
      });
    } catch (error) {
      showStatus('❌ 无法启动截屏翻译', 'error');
    }
  });

  // ---------- 辅助函数 ----------
  function toggleModeSettings() {
    const mode = document.getElementById('translationMode').value;
    document.getElementById('visionSettings').style.display = mode === 'vision' ? 'block' : 'none';
    document.getElementById('ocrSettings').style.display = mode === 'ocr' ? 'block' : 'none';
    document.getElementById('rerankSettings').style.display = mode === 'rerank' ? 'block' : 'none';
  }
});

function showStatus(message, type = 'info') {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = 'status';
  switch (type) {
    case 'success': statusEl.classList.add('status-success'); break;
    case 'error': statusEl.classList.add('status-error'); break;
    case 'info': statusEl.classList.add('status-info'); break;
  }
  setTimeout(() => {
    statusEl.style.opacity = '0';
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.style.opacity = '1';
      statusEl.className = 'status';
    }, 500);
  }, 2000);
}