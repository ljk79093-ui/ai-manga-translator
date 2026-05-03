// options.js
// 自动保存版本 + 统计 + 缓存管理 + 后处理开关 + 气泡排版

document.addEventListener('DOMContentLoaded', async () => {
  // ---------- 读取全部配置 ----------
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
    'boxBgColor', 'boxTextColor', 'boxOpacity',
    'devMode',
    'cacheApiUrl', 'cacheApiKey',
    'enablePostprocess', 'bubblePreset'   // 新增
  ]);

  // ===================== 基础设置填充 =====================
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

  // 样式
  document.getElementById('boxBgColor').value = result.boxBgColor || '#000000';
  document.getElementById('boxTextColor').value = result.boxTextColor || '#ffffff';
  document.getElementById('boxOpacity').value = result.boxOpacity || 0.6;
  document.getElementById('opacityValue').textContent = document.getElementById('boxOpacity').value;

  // 开发者选项
  document.getElementById('devMode').checked = result.devMode === true;
  document.getElementById('cacheApiUrl').value = result.cacheApiUrl || '';
  document.getElementById('cacheApiKey').value = result.cacheApiKey || '';

  // 新增：后处理开关
  document.getElementById('enablePostprocess').checked = result.enablePostprocess !== false; // 默认开启
  // 气泡排版预设
  document.getElementById('bubblePreset').value = result.bubblePreset || 'mangaClassic';

  toggleModeSettings();

  // ===================== 事件监听 =====================
  document.getElementById('translationMode').addEventListener('change', () => {
    toggleModeSettings();
    debounceSave();
  });

  document.getElementById('boxBgColor').addEventListener('input', debounceSave);
  document.getElementById('boxTextColor').addEventListener('input', debounceSave);
  document.getElementById('boxOpacity').addEventListener('input', (e) => {
    document.getElementById('opacityValue').textContent = e.target.value;
    debounceSave();
  });
  document.getElementById('devMode').addEventListener('change', debounceSave);
  document.getElementById('cacheApiUrl').addEventListener('input', debounceSave);
  document.getElementById('cacheApiKey').addEventListener('input', debounceSave);

  // 新增事件
  document.getElementById('enablePostprocess').addEventListener('change', debounceSave);
  document.getElementById('bubblePreset').addEventListener('change', debounceSave);

  // 恢复默认设置
  document.getElementById('resetDefaultsBtn').addEventListener('click', async () => {
    if (!confirm('确定要恢复所有设置为默认值吗？此操作不可撤销！')) return;
    const keysToRemove = [
      'apiKey','model','targetLang','prompt','apiEndpoint',
      'floatIconUrl','floatIconWidth','floatIconHeight',
      'maxConcurrent','translationMode','ocrApiKey','translateModel',
      'ocrApiEndpoint','ocrModel','translateApiEndpoint','translateApiKey',
      'imageMaxDimension','maxTokens','floatButtonEnabled',
      'rerankOcrApiEndpoint','rerankOcrApiKey','rerankOcrModel',
      'rerankApiEndpoint','rerankApiKey','rerankModel',
      'rerankTranslateApiEndpoint','rerankTranslateApiKey','rerankTranslateModel',
      'ocrTranslatePrompt','rerankTranslatePrompt','ocrVisionPrompt',
      'boxBgColor','boxTextColor','boxOpacity','devMode',
      'cacheApiUrl','cacheApiKey',
      'enablePostprocess','bubblePreset'   // 新增
    ];
    await chrome.storage.sync.remove(keysToRemove);
    await chrome.storage.local.remove('translationStats');
    location.reload();
  });

  // ===================== 缓存管理 =====================
  updateMemoryCacheCount();

  document.getElementById('clearMemCacheBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'clearTranslationMemory' }, () => {
        updateMemoryCacheCount();
        showStatus('内存缓存已清除', 'success');
      });
    } else {
      showStatus('未找到活动标签页', 'error');
    }
  });

  document.getElementById('clearDBCacheBtn').addEventListener('click', async () => {
    const cacheApiUrl = document.getElementById('cacheApiUrl').value.trim();
    const cacheApiKey = document.getElementById('cacheApiKey').value.trim();
    if (!cacheApiUrl) {
      showStatus('请先填写缓存 API 地址', 'error');
      return;
    }
    try {
      const url = cacheApiUrl.replace(/\/$/, '') + '/cache/clear';
      const headers = { 'Content-Type': 'application/json' };
      if (cacheApiKey) headers['X-API-Key'] = cacheApiKey;
      const res = await fetch(url, { method: 'POST', headers });
      if (res.ok) {
        document.getElementById('dbCacheStatus').textContent = '已清空';
        showStatus('MySQL 缓存已清空', 'success');
      } else {
        showStatus('清空失败，后端返回 ' + res.status, 'error');
      }
    } catch (e) {
      showStatus('清空请求失败: ' + e.message, 'error');
    }
  });

  // ===================== 自动保存逻辑 =====================
  let saveTimeout = null;
  const SAVE_DELAY = 800;

  async function saveSettings() {
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

    const boxBgColor = document.getElementById('boxBgColor').value;
    const boxTextColor = document.getElementById('boxTextColor').value;
    const boxOpacity = parseFloat(document.getElementById('boxOpacity').value);
    const devMode = document.getElementById('devMode').checked;
    const cacheApiUrl = document.getElementById('cacheApiUrl').value.trim();
    const cacheApiKey = document.getElementById('cacheApiKey').value.trim();

    // 新增字段
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
      boxBgColor,
      boxTextColor,
      boxOpacity,
      devMode,
      cacheApiUrl,
      cacheApiKey,
      enablePostprocess,
      bubblePreset
    });

    showStatus('✅ 已自动保存', 'success');
  }

  function debounceSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveSettings(), SAVE_DELAY);
  }

  // 为所有输入元素绑定自动保存
  const allInputs = document.querySelectorAll('input, select, textarea');
  allInputs.forEach(input => {
    input.addEventListener('input', debounceSave);
    input.addEventListener('change', debounceSave);
  });

  // ===================== 界面辅助 =====================
  function toggleModeSettings() {
    const mode = document.getElementById('translationMode').value;
    document.getElementById('visionSettings').style.display = mode === 'vision' ? 'block' : 'none';
    document.getElementById('ocrSettings').style.display = mode === 'ocr' ? 'block' : 'none';
    document.getElementById('rerankSettings').style.display = mode === 'rerank' ? 'block' : 'none';
  }

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

  // ===================== 统计加载 =====================
  async function loadStats() {
    const { translationStats: stats } = await chrome.storage.local.get('translationStats');
    if (!stats) return;
    document.getElementById('statTotal').textContent = stats.totalImages || 0;
    const total = stats.totalImages || 1;
    const rate = ((stats.totalSuccess || 0) / total * 100).toFixed(1);
    document.getElementById('statRate').textContent = rate + '%';
    const modesList = document.getElementById('statModes');
    modesList.innerHTML = '';
    if (stats.modes) {
      for (const [mode, data] of Object.entries(stats.modes)) {
        const li = document.createElement('li');
        li.textContent = `${mode}: ${data.count || 0} 次`;
        modesList.appendChild(li);
      }
    }
  }
  await loadStats();

  document.getElementById('resetStatsBtn').addEventListener('click', async () => {
    await chrome.storage.local.remove('translationStats');
    await loadStats();
  });

  // ===================== 内存缓存数量更新 =====================
  async function updateMemoryCacheCount() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'getMemoryCacheCount' }, (response) => {
        if (response) {
          document.getElementById('memCacheCount').textContent = response.count || 0;
        } else {
          document.getElementById('memCacheCount').textContent = '未知';
        }
      });
    }
  }
});