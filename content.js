// content.js
// ========================================================================
//  AI 漫画翻译 - 内容脚本 (Content Script)
// ========================================================================
//
//  功能概述：
//    - 在网页上为所有图片创建可拖动的翻译浮层。
//    - 提供悬浮按钮及功能菜单（开始翻译、截屏翻译、模式切换、参数设置等）。
//    - 支持懒加载页面：自动滚动加载全部图片后再翻译。
//    - 虚拟滚动优化：图片离开视口被卸载后，再次出现时自动恢复翻译框。
//    - 翻译框可自由拖动、双击复位，支持竖排文字显示。
//    - 悬浮菜单根据按钮位置自动调整弹出方位（四象限）。
//    - 截屏翻译：截取当前屏幕并显示翻译结果覆盖层。
//    - 调试工具：在控制台暴露 `__mangaDebug` 对象。
//    - 自定义样式：翻译框颜色、透明度等可从选项页同步。
//    - 集成气泡适配引擎（仅优化字号与换行，不改变外观）。
//
//  架构：
//    - 接收来自 background.js 的翻译结果，并渲染到页面上。
//    - 通过 chrome.storage 读取配置（并发数、重试次数等）。
//    - 与 background.js 通信使用 chrome.runtime.sendMessage。
//
//  主要 API：
//    chrome.runtime.onMessage 监听：
//      - translatePage : 开始翻译所有图片
//      - showCaptureTranslation : 显示截屏翻译结果
//      - clearTranslationMemory : 清空内存翻译缓存
//
//  全局变量：
//    translationCache      : Map<url, result> 翻译结果去重缓存
//    imageTranslationMap   : Map<url, result> 持久内存缓存（用于虚拟滚动恢复）
//    pendingRequests       : Map<url, Promise> 正在请求中的 Promise
//    stopTranslation       : boolean 是否停止翻译
//    currentRetryLimit     : number 当前重试次数上限
//    failedImages          : Map<url, {img, retryCount}> 失败重试队列
//
// ========================================================================

const translationCache = new Map();
const imageTranslationMap = new Map();
const pendingRequests = new Map();
let stopTranslation = false;

let currentRetryLimit = 3;
let failedImages = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case 'translatePage':
      translateAllImages();
      sendResponse({ status: '翻译任务已启动，请稍候...' });
      break;
    case 'showCaptureTranslation':
      showCaptureOverlay(request.imageData, request.translation);
      sendResponse({ status: 'overlay shown' });
      break;
    case 'clearTranslationMemory':
      translationCache.clear();
      imageTranslationMap.clear();
      sendResponse({ status: 'memory cleared' });
      break;
    case 'getMemoryCacheCount':
      sendResponse({ count: imageTranslationMap.size });
      break;
  }
});

// ===================== 自动滚动加载所有图片 =====================
/**
 * 自动向下滚动页面，触发懒加载图片的加载
 * 等待所有图片加载完成后 resolve
 * @returns {Promise<boolean>}
 */
async function autoScrollToLoadAllImages() {
  return new Promise((resolve) => {
    let totalHeight = 0;
    const distance = window.innerHeight * 0.5;
    const waitTime = 800;
    const maxScrolls = 100;
    let scrollCount = 0;

    const timer = setInterval(() => {
      window.scrollBy(0, distance);
      totalHeight += distance;
      scrollCount++;

      if (totalHeight >= document.body.scrollHeight - window.innerHeight || scrollCount >= maxScrolls) {
        clearInterval(timer);
        setTimeout(() => resolve(true), 2000);
      }
    }, waitTime);
  });
}

// ===================== 主翻译入口 =====================
/**
 * 翻译页面中所有图片
 * @param {function} onProgress - 进度回调 (completed, total)
 */
async function translateAllImages(onProgress) {
  stopTranslation = false;
  failedImages.clear();

  const { retryLimit } = await chrome.storage.sync.get('retryLimit');
  currentRetryLimit = retryLimit || 3;
  const { maxConcurrent } = await chrome.storage.sync.get('maxConcurrent');
  const concurrent = maxConcurrent || 3;

  const images = document.querySelectorAll('img');
  if (images.length === 0) {
    alert('当前页面没有找到图片。');
    if (onProgress) onProgress(0, 0);
    return;
  }

  const total = images.length;
  let completed = 0;
  let processedCount = total;

  const updateProgress = () => {
    completed++;
    if (onProgress) onProgress(completed, processedCount);
  };

  await processImageBatch(Array.from(images), concurrent, updateProgress);

  while (failedImages.size > 0 && !stopTranslation) {
    const retryBatch = Array.from(failedImages.values()).map(item => item.img);
    failedImages.clear();
    processedCount += retryBatch.length;
    await processImageBatch(retryBatch, concurrent, updateProgress);
  }

  if (onProgress) onProgress(processedCount, processedCount);
}

async function processImageBatch(imageList, concurrent, updateProgress) {
  for (let i = 0; i < imageList.length; i += concurrent) {
    if (stopTranslation) break;
    const batch = imageList.slice(i, i + concurrent);
    const batchPromises = batch.map(img => processImage(img, updateProgress));
    await Promise.allSettled(batchPromises);
  }
}

async function processImage(img, updateProgress) {
  if (stopTranslation) return;

  let retryCount = parseInt(img.dataset.retryCount) || 0;

  if (img.dataset.translating === 'true') {
    updateProgress();
    return;
  }
  if (img.naturalWidth < 50 || img.naturalHeight < 50) {
    updateProgress();
    return;
  }

  const imgUrl = img.src;
  const wrapper = ensureWrapper(img);

  if (imageTranslationMap.has(imgUrl)) {
    applyTranslationResult(wrapper, imageTranslationMap.get(imgUrl));
    updateProgress();
    return;
  }

  if (translationCache.has(imgUrl)) {
    applyTranslationResult(wrapper, translationCache.get(imgUrl));
    updateProgress();
    return;
  }

  if (pendingRequests.has(imgUrl)) {
    const result = await pendingRequests.get(imgUrl);
    applyTranslationResult(wrapper, result);
    updateProgress();
    return;
  }

  img.dataset.translating = 'true';
  showSingleFloatingBox(wrapper, '翻译中...', 'loading');

  const requestPromise = new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { action: 'translateImage', imgUrl },
      (response) => {
        wrapper.querySelectorAll('.floating-translation-box').forEach(box => box.remove());

        let result;
        if (response?.success) {
          result = { success: true, data: response.text };
        } else {
          result = { success: false, error: response?.error || '未知错误' };
        }
        resolve(result);
      }
    );
  });

  pendingRequests.set(imgUrl, requestPromise);
  const result = await requestPromise;
  pendingRequests.delete(imgUrl);
  img.dataset.translating = 'false';

  if (result.success) {
    translationCache.set(imgUrl, result);
    imageTranslationMap.set(imgUrl, result);
    delete img.dataset.retryCount;
    applyTranslationResult(wrapper, result);
    updateProgress();
  } else {
    retryCount++;
    if (retryCount <= currentRetryLimit) {
      img.dataset.retryCount = retryCount;
      img.dataset.translating = 'false';
      failedImages.set(imgUrl, { img, retryCount });
      showSingleFloatingBox(wrapper, `翻译失败，正在重试 (${retryCount}/${currentRetryLimit})...`, 'loading');
      updateProgress();
    } else {
      delete img.dataset.retryCount;
      translationCache.set(imgUrl, result);
      applyTranslationResult(wrapper, result);
      updateProgress();
    }
  }
}

function applyTranslationResult(wrapper, result) {
  if (result.success) {
    const data = result.data;
    if (data.type === 'multi') {
      showMultiFloatingBoxes(wrapper, data.items);
    } else {
      showSingleFloatingBox(wrapper, data.text, 'result');
    }
  } else {
    showSingleFloatingBox(wrapper, `翻译失败: ${result.error}`, 'error');
  }
}

function ensureWrapper(img) {
  if (img.parentNode?.classList.contains('translation-wrapper')) {
    return img.parentNode;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'translation-wrapper';
  wrapper.style.cssText = 'position: relative; display: inline-block; max-width: 100%; line-height: 0; font-size: 0;';
  img.parentNode.insertBefore(wrapper, img);
  wrapper.appendChild(img);
  return wrapper;
}

// ===================== 多文本框渲染 =====================
async function showMultiFloatingBoxes(wrapper, items) {
  const img = wrapper.querySelector('img');
  if (!img.complete) {
    img.onload = () => renderMultiBoxes(wrapper, items, img);
  } else {
    await renderMultiBoxes(wrapper, items, img);
  }
}

async function renderMultiBoxes(wrapper, items, img) {
  const imgOffsetLeft = img.offsetLeft;
  const imgOffsetTop = img.offsetTop;
  const imgRect = img.getBoundingClientRect();
  const imgWidth = imgRect.width;
  const imgHeight = imgRect.height;
  const wrapperRect = wrapper.getBoundingClientRect();

  if (imgWidth === 0 || imgHeight === 0) return;

  const placedRects = [];

  for (const item of items) {
    const { text, bbox, direction = 'horizontal' } = item;
    if (!bbox || bbox.length < 4) continue;

    // 原始像素坐标（使用 OCR 归一化 bbox）
    const x1 = bbox[0] * imgWidth;
    const y1 = bbox[1] * imgHeight;
    const x2 = bbox[2] * imgWidth;
    const y2 = bbox[3] * imgHeight;

    // 调用气泡适配引擎，仅获取优化后的字号和折行文本，不修改坐标
    let displayText = text;
    let optimalFontSize = 16;
    if (typeof fitTextToBubbleRegion === 'function') {
      try {
        const fitResult = await fitTextToBubbleRegion(img, bbox, text, { direction });
        if (fitResult && fitResult.layout && fitResult.layout.lines) {
          displayText = fitResult.layout.lines.join('\n');
          optimalFontSize = Math.max(12, fitResult.layout.fontSize);
        }
      } catch (e) {
        console.warn('气泡适配引擎调用失败，使用默认字号', e);
      }
    }

    const box = createTranslationBox(displayText, 'result', { direction });
    box.style.fontSize = optimalFontSize + 'px';
    wrapper.appendChild(box);
    const boxWidth = box.offsetWidth;
    const boxHeight = box.offsetHeight;

    let idealLeft, idealTop;
    if (direction === 'vertical') {
      idealLeft = imgOffsetLeft + x2;
      idealTop = imgOffsetTop + y1 + (y2 - y1 - boxHeight) / 2;
    } else {
      idealLeft = imgOffsetLeft + x1;
      idealTop = imgOffsetTop + y2;
    }

    // 边界修正
    if (direction === 'vertical') {
      if (idealLeft + boxWidth > wrapperRect.width) {
        idealLeft = imgOffsetLeft + x1 - boxWidth;
        if (idealLeft < 0) idealLeft = 0;
      }
      if (idealTop < 0) idealTop = 0;
      if (idealTop + boxHeight > wrapperRect.height) {
        idealTop = wrapperRect.height - boxHeight;
        if (idealTop < 0) idealTop = 0;
      }
    } else {
      if (idealTop + boxHeight > wrapperRect.height) {
        idealTop = imgOffsetTop + y1 - boxHeight;
        if (idealTop < 0) idealTop = 0;
      }
      if (idealLeft < 0) idealLeft = 0;
      if (idealLeft + boxWidth > wrapperRect.width) {
        idealLeft = wrapperRect.width - boxWidth;
        if (idealLeft < 0) idealLeft = 0;
      }
    }

    const { left, top } = getAdjustedPosition(
      idealLeft, idealTop, boxWidth, boxHeight,
      wrapperRect, placedRects, direction,
      imgOffsetLeft + x1, imgOffsetTop + y1, imgOffsetLeft + x2, imgOffsetTop + y2
    );

    box.style.left = left + 'px';
    box.style.top = top + 'px';

    placedRects.push({ left, top, width: boxWidth, height: boxHeight });

    makeDraggable(box, wrapper);

    box.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      let newLeft, newTop;
      if (direction === 'vertical') {
        newLeft = imgOffsetLeft + x2;
        newTop = imgOffsetTop + y1 + (y2 - y1 - boxHeight) / 2;
      } else {
        newLeft = imgOffsetLeft + x1;
        newTop = imgOffsetTop + y2;
      }
      box.style.left = newLeft + 'px';
      box.style.top = newTop + 'px';
    });
  }
}

function isOverlapping(left, top, width, height, containerRect, placedRects, margin = 2) {
  if (left < 0 || top < 0 || left + width > containerRect.width || top + height > containerRect.height) return true;
  for (const rect of placedRects) {
    if (!(left + width + margin < rect.left || left > rect.left + rect.width + margin ||
          top + height + margin < rect.top || top > rect.top + rect.height + margin)) {
      return true;
    }
  }
  return false;
}

function getAdjustedPosition(idealLeft, idealTop, boxWidth, boxHeight, containerRect, placedRects, direction, x1, y1, x2, y2) {
  if (!isOverlapping(idealLeft, idealTop, boxWidth, boxHeight, containerRect, placedRects)) {
    return { left: idealLeft, top: idealTop };
  }

  if (direction !== 'vertical') {
    let topAbove = y1 - boxHeight;
    if (topAbove >= 0 && !isOverlapping(x1, topAbove, boxWidth, boxHeight, containerRect, placedRects)) {
      return { left: x1, top: topAbove };
    }
    let leftLeft = x1 - boxWidth;
    if (leftLeft >= 0 && !isOverlapping(leftLeft, y2, boxWidth, boxHeight, containerRect, placedRects)) {
      return { left: leftLeft, top: y2 };
    }
    let rightRight = x2;
    if (rightRight + boxWidth <= containerRect.width && !isOverlapping(rightRight, y2, boxWidth, boxHeight, containerRect, placedRects)) {
      return { left: rightRight, top: y2 };
    }
  } else {
    let leftLeft = x1 - boxWidth;
    if (leftLeft >= 0 && !isOverlapping(leftLeft, idealTop, boxWidth, boxHeight, containerRect, placedRects)) {
      return { left: leftLeft, top: idealTop };
    }
  }

  let baseLeft = (containerRect.width - boxWidth) / 2;
  let baseTop = containerRect.height - boxHeight - 10;
  for (let offset = 0; baseTop + offset + boxHeight <= containerRect.height; offset += 5) {
    let candidateTop = baseTop + offset;
    if (!isOverlapping(baseLeft, candidateTop, boxWidth, boxHeight, containerRect, placedRects)) {
      return { left: baseLeft, top: candidateTop };
    }
  }
  return { left: idealLeft, top: idealTop };
}

// ===================== 单文本框 =====================
async function showSingleFloatingBox(wrapper, text, type) {
  wrapper.querySelectorAll('.floating-translation-box').forEach(box => box.remove());

  const img = wrapper.querySelector('img');
  const imgOffsetLeft = img.offsetLeft;
  const imgOffsetTop = img.offsetTop;
  const imgRect = img.getBoundingClientRect();
  const imgWidth = imgRect.width;
  const imgHeight = imgRect.height;

  let displayText = text;
  let optimalFontSize = 16;
  if (typeof fitTextToBubbleRegion === 'function' && type === 'result') {
    try {
      const fitResult = await fitTextToBubbleRegion(img, [0, 0, 1, 1], text, { direction: 'horizontal' });
      if (fitResult && fitResult.layout && fitResult.layout.lines) {
        displayText = fitResult.layout.lines.join('\n');
        optimalFontSize = Math.max(12, fitResult.layout.fontSize);
      }
    } catch (e) { /* 忽略 */ }
  }

  const box = createTranslationBox(displayText, type);
  box.style.fontSize = optimalFontSize + 'px';
  wrapper.appendChild(box);

  const boxWidth = box.offsetWidth;
  const boxHeight = box.offsetHeight;

  let left = imgOffsetLeft + (imgWidth - boxWidth) / 2;
  if (left < 0) left = 5;
  let top = imgOffsetTop + imgHeight - boxHeight - 10;
  if (top < 0) top = 5;

  box.style.left = left + 'px';
  box.style.top = top + 'px';

  makeDraggable(box, wrapper);

  box.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const currImg = wrapper.querySelector('img');
    const currOffsetLeft = currImg.offsetLeft;
    const currOffsetTop = currImg.offsetTop;
    const currRect = currImg.getBoundingClientRect();
    const currWidth = currRect.width;
    const currHeight = currRect.height;

    let newLeft = currOffsetLeft + (currWidth - box.offsetWidth) / 2;
    if (newLeft < 0) newLeft = 5;
    let newTop = currOffsetTop + currHeight - box.offsetHeight - 10;
    if (newTop < 0) newTop = 5;
    box.style.left = newLeft + 'px';
    box.style.top = newTop + 'px';
  });
}

function createTranslationBox(text, type, options = {}) {
  const box = document.createElement('div');
  box.className = 'floating-translation-box';
  box.textContent = text;

  Object.assign(box.style, {
    position: 'absolute',
    background: 'rgba(0, 0, 0, 0.6)',
    color: 'white',
    fontSize: '16px',
    fontWeight: 'bold',
    padding: '8px 12px',
    borderRadius: '4px',
    borderLeft: '4px solid #4CAF50',
    maxWidth: 'min(80%, 600px)',
    overflowWrap: 'break-word',
    wordWrap: 'break-word',
    wordBreak: 'break-word',
    zIndex: 9999,
    cursor: 'move',
    userSelect: 'none',
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    pointerEvents: 'auto',
    whiteSpace: 'pre-wrap',
    lineHeight: '1.5',
    touchAction: 'none'
  });

  if (options.direction === 'vertical') {
    Object.assign(box.style, {
      writingMode: 'vertical-rl',
      textOrientation: 'upright',
      whiteSpace: 'nowrap',
      maxHeight: '80%',
      maxWidth: 'unset',
      width: 'auto',
      padding: '12px 8px'
    });
  }

  if (type === 'loading') {
    box.style.background = 'rgba(255, 193, 7, 0.8)';
    box.style.color = '#333';
    box.style.borderLeftColor = '#FF9800';
  } else if (type === 'error') {
    box.style.background = 'rgba(244, 67, 54, 0.8)';
    box.style.borderLeftColor = '#F44336';
  }

  applyCustomBoxStyle(box);
  return box;
}

async function applyCustomBoxStyle(box) {
  try {
    const cfg = await chrome.storage.sync.get(['boxBgColor', 'boxTextColor', 'boxOpacity']);
    if (cfg.boxBgColor || cfg.boxTextColor || cfg.boxOpacity) {
      const bg = cfg.boxBgColor || '#000000';
      const r = parseInt(bg.slice(1,3), 16);
      const g = parseInt(bg.slice(3,5), 16);
      const b = parseInt(bg.slice(5,7), 16);
      const opacity = cfg.boxOpacity || 0.6;
      box.style.background = `rgba(${r},${g},${b},${opacity})`;
      if (cfg.boxTextColor) box.style.color = cfg.boxTextColor;
    }
  } catch (e) {
    console.warn('获取自定义样式失败', e);
  }
}

// ===================== 拖动功能 =====================
function makeDraggable(element, container) {
  let isDragging = false;
  let hasMoved = false;
  let startX, startY, startLeft, startTop;
  let rafId = null;
  const moveThreshold = 2;

  const onPointerDown = (e) => {
    e.preventDefault();
    isDragging = true;
    hasMoved = false;
    const rect = element.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    element.setPointerCapture(e.pointerId);
    element.style.cursor = 'grabbing';
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > moveThreshold || Math.abs(dy) > moveThreshold) hasMoved = true;

    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      const containerRect = container.getBoundingClientRect();
      let left = startLeft + dx - containerRect.left;
      let top = startTop + dy - containerRect.top;

      left = Math.max(0, Math.min(left, containerRect.width - element.offsetWidth));
      top = Math.max(0, Math.min(top, containerRect.height - element.offsetHeight));

      element.style.left = left + 'px';
      element.style.top = top + 'px';
      rafId = null;
    });
  };

  const onPointerUp = (e) => {
    if (!isDragging) return;
    element.releasePointerCapture(e.pointerId);
    element.style.cursor = 'move';
    isDragging = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', onPointerUp);
  element.addEventListener('pointercancel', onPointerUp);
}

// ===================== 截屏翻译覆盖层 =====================
function showCaptureOverlay(imageData, translation) {
  const existing = document.getElementById('manga-capture-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'manga-capture-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    backgroundColor: 'rgba(0,0,0,0.7)',
    zIndex: 10000000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'auto'
  });

  if (!translation) {
    overlay.textContent = '⏳ 正在翻译截屏…';
    overlay.style.color = 'white';
    overlay.style.fontSize = '24px';
    overlay.style.fontWeight = 'bold';
    document.body.appendChild(overlay);
    return;
  }

  const imgContainer = document.createElement('div');
  imgContainer.style.position = 'relative';
  imgContainer.style.maxWidth = '90%';
  imgContainer.style.maxHeight = '90%';
  imgContainer.style.boxShadow = '0 0 20px rgba(0,0,0,0.5)';

  const img = document.createElement('img');
  img.src = imageData;
  img.style.display = 'block';
  img.style.width = '100%';
  img.style.height = 'auto';
  img.style.maxHeight = '90vh';
  img.style.objectFit = 'contain';

  imgContainer.appendChild(img);
  overlay.appendChild(imgContainer);
  document.body.appendChild(overlay);

  img.onload = () => {
    const imgWidth = img.naturalWidth;
    const imgHeight = img.naturalHeight;
    const displayWidth = img.clientWidth;
    const displayHeight = img.clientHeight;

    if (translation.type === 'multi' && translation.items.length) {
      translation.items.forEach(item => {
        const { text, bbox } = item;
        if (!bbox || bbox.length < 4) return;

        const x1 = bbox[0] * displayWidth;
        const y1 = bbox[1] * displayHeight;
        const x2 = bbox[2] * displayWidth;
        const y2 = bbox[3] * displayHeight;

        const box = createTranslationBox(text, 'result', { direction: item.direction || 'horizontal' });
        imgContainer.appendChild(box);

        let left = x1;
        let top = y2;
        const boxWidth = box.offsetWidth;
        const boxHeight = box.offsetHeight;

        if (top + boxHeight > displayHeight) top = y1 - boxHeight;
        if (left + boxWidth > displayWidth) left = displayWidth - boxWidth;
        if (left < 0) left = 0;
        if (top < 0) top = 0;

        box.style.left = left + 'px';
        box.style.top = top + 'px';
        makeDraggable(box, imgContainer);

        box.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          let newLeft = x1;
          let newTop = y2;
          if (newTop + boxHeight > displayHeight) newTop = y1 - boxHeight;
          if (newLeft + boxWidth > displayWidth) newLeft = displayWidth - boxWidth;
          if (newLeft < 0) newLeft = 0;
          if (newTop < 0) newTop = 0;
          box.style.left = newLeft + 'px';
          box.style.top = newTop + 'px';
        });
      });
    } else if (translation.type === 'single') {
      const box = createTranslationBox(translation.text, 'result');
      imgContainer.appendChild(box);
      box.style.left = ((displayWidth - box.offsetWidth) / 2) + 'px';
      box.style.top = (displayHeight - box.offsetHeight - 10) + 'px';
      makeDraggable(box, imgContainer);
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
  };
}

// ===================== 悬浮按钮管理 =====================
async function initFloatingButton() {
  cleanupFloatingElements();

  const { floatButtonEnabled } = await chrome.storage.sync.get('floatButtonEnabled');
  if (floatButtonEnabled === false) {
    console.log('🚫 悬浮窗已禁用，不创建');
  } else {
    createFloatingElements();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.floatButtonEnabled) {
      const enabled = changes.floatButtonEnabled.newValue;
      if (enabled === false) {
        cleanupFloatingElements();
      } else {
        if (!document.getElementById('manga-translator-float')) {
          createFloatingElements();
        }
      }
    }
    if (changes.floatIconUrl || changes.floatIconWidth || changes.floatIconHeight) {
      updateFloatingIconStyle(changes);
    }
  });
}

function cleanupFloatingElements() {
  document.getElementById('manga-translator-float')?.remove();
  document.getElementById('manga-translator-menu')?.remove();
  document.getElementById('manga-translator-progress')?.remove();
  document.getElementById('manga-translator-recovery')?.remove();
}

function createFloatingElements() {
  console.log('创建悬浮按钮...');
  const floatBtn = document.createElement('div');
  floatBtn.id = 'manga-translator-float';
  Object.assign(floatBtn.style, {
    position: 'fixed',
    top: '20px',
    left: '20px',
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    background: '#4CAF50',
    cursor: 'grab',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    zIndex: 999999,
    userSelect: 'none',
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '24px',
    color: 'white',
    touchAction: 'none'
  });

  chrome.storage.sync.get(['floatIconUrl', 'floatIconWidth', 'floatIconHeight'], (result) => {
    if (result.floatIconUrl) {
      floatBtn.style.backgroundImage = `url(${result.floatIconUrl})`;
      floatBtn.textContent = '';
    } else {
      floatBtn.textContent = '📖';
    }
    if (result.floatIconWidth) {
      floatBtn.style.width = result.floatIconWidth + 'px';
      floatBtn.style.height = result.floatIconHeight ? result.floatIconHeight + 'px' : result.floatIconWidth + 'px';
    }
    if (result.floatIconHeight) {
      floatBtn.style.height = result.floatIconHeight + 'px';
    }
  });

  document.body.appendChild(floatBtn);
  restoreFloatPosition(floatBtn);

  const menu = document.createElement('div');
  menu.id = 'manga-translator-menu';
  Object.assign(menu.style, {
    position: 'fixed',
    display: 'none',
    background: 'white',
    border: '1px solid #ccc',
    borderRadius: '8px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    padding: '8px 0',
    minWidth: '200px',
    zIndex: 1000000,
    fontSize: '14px'
  });
  document.body.appendChild(menu);

  const progressEl = document.createElement('div');
  progressEl.id = 'manga-translator-progress';
  Object.assign(progressEl.style, {
    position: 'fixed',
    display: 'none',
    background: '#4CAF50',
    color: 'white',
    borderRadius: '16px',
    padding: '4px 12px',
    fontSize: '14px',
    fontWeight: 'bold',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    zIndex: 1000000,
    whiteSpace: 'nowrap',
    pointerEvents: 'none'
  });
  document.body.appendChild(progressEl);

  async function populateMenu() {
    const {
      maxTokens = 1000, maxConcurrent = 3, translationMode = 'vision',
      imageMaxDimension = 1024, retryLimit = 3
    } = await chrome.storage.sync.get([
      'maxTokens', 'maxConcurrent', 'translationMode', 'imageMaxDimension', 'retryLimit'
    ]);

    menu.innerHTML = '';

    let modeText;
    if (translationMode === 'vision') modeText = '📷 视觉模式';
    else if (translationMode === 'ocr') modeText = '🔍 OCR模式';
    else modeText = '✨ 精致机翻';

    const items = [
      { text: '▶ 加载并翻译', action: 'loadAndTranslate' },
      { text: '⏹ 停止翻译', action: 'stop' },
      { text: '📸 截屏翻译', action: 'capture' },
      { text: modeText, action: 'toggleMode', currentMode: translationMode },
      { text: `🔢 Token限制: ${maxTokens}`, action: 'setToken', value: maxTokens },
      { text: `🌐 并发数: ${maxConcurrent}`, action: 'setConcurrent', value: maxConcurrent },
      { text: `📏 压缩尺寸: ${imageMaxDimension}px`, action: 'setImageDimension', value: imageMaxDimension },
      { text: `🔄 重试次数: ${retryLimit}`, action: 'setRetryLimit', value: retryLimit },
      { text: '👻 隐藏悬浮窗', action: 'hide' },
      { text: '⚙ 扩展配置', action: 'options' }
    ];

    items.forEach(item => {
      const div = document.createElement('div');
      div.textContent = item.text;
      div.style.padding = '8px 16px';
      div.style.cursor = 'pointer';
      div.style.borderBottom = '1px solid #f0f0f0';
      div.addEventListener('mouseenter', () => div.style.background = '#f5f5f5');
      div.addEventListener('mouseleave', () => div.style.background = 'transparent');

      div.addEventListener('click', async (e) => {
        e.stopPropagation();
        menu.style.display = 'none';

        switch (item.action) {
          case 'loadAndTranslate':
            await autoScrollToLoadAllImages();
            startTranslationWithProgress();
            break;
          case 'stop':
            stopTranslation = true;
            progressEl.style.display = 'none';
            break;
          case 'capture':
            chrome.runtime.sendMessage({ action: 'captureAndTranslate' });
            break;
          case 'toggleMode': {
            let newMode;
            if (item.currentMode === 'vision') newMode = 'ocr';
            else if (item.currentMode === 'ocr') newMode = 'rerank';
            else newMode = 'vision';
            await chrome.storage.sync.set({ translationMode: newMode });
            await populateMenu();
            const btnRect = floatBtn.getBoundingClientRect();
            const tip = document.createElement('div');
            tip.textContent = `已切换为${newMode === 'vision' ? '视觉模式' : (newMode === 'ocr' ? 'OCR模式' : '精致机翻模式')}`;
            Object.assign(tip.style, {
              position: 'fixed',
              left: btnRect.left + 'px',
              top: (btnRect.bottom + 5) + 'px',
              background: '#333',
              color: '#fff',
              padding: '4px 8px',
              borderRadius: '4px',
              fontSize: '12px',
              zIndex: 1000001
            });
            document.body.appendChild(tip);
            setTimeout(() => tip.remove(), 1500);
            break;
          }
          case 'setToken': {
            const val = prompt('请输入新的Token限制 (100-16000):', item.value);
            if (val !== null) {
              const num = parseInt(val, 10);
              if (!isNaN(num) && num >= 100 && num <= 16000) {
                await chrome.storage.sync.set({ maxTokens: num });
                await populateMenu();
              } else alert('请输入100-16000之间的整数');
            }
            break;
          }
          case 'setConcurrent': {
            const val = prompt('请输入新的并发数 (1-20):', item.value);
            if (val !== null) {
              const num = parseInt(val, 10);
              if (!isNaN(num) && num >= 1 && num <= 20) {
                await chrome.storage.sync.set({ maxConcurrent: num });
                await populateMenu();
              } else alert('请输入1-20之间的整数');
            }
            break;
          }
          case 'setImageDimension': {
            const val = prompt('请输入新的图片压缩尺寸 (256-4096):', item.value);
            if (val !== null) {
              const num = parseInt(val, 10);
              if (!isNaN(num) && num >= 256 && num <= 4096) {
                await chrome.storage.sync.set({ imageMaxDimension: num });
                await populateMenu();
              } else alert('请输入256-4096之间的整数');
            }
            break;
          }
          case 'setRetryLimit': {
            const val = prompt('请输入最大重试次数 (0-10):', item.value);
            if (val !== null) {
              const num = parseInt(val, 10);
              if (!isNaN(num) && num >= 0 && num <= 10) {
                await chrome.storage.sync.set({ retryLimit: num });
                await populateMenu();
              } else alert('请输入0-10之间的整数');
            }
            break;
          }
          case 'hide':
            hideFloatButton();
            break;
          case 'options':
            chrome.runtime.sendMessage({ action: 'openOptionsPage' });
            break;
        }
      });

      menu.appendChild(div);
    });
  }

  function hideFloatButton() {
    menu.style.display = 'none';
    progressEl.style.display = 'none';
    const rect = floatBtn.getBoundingClientRect();
    const btnLeft = rect.left, btnTop = rect.top, btnWidth = rect.width, btnHeight = rect.height;
    floatBtn.style.display = 'none';

    const recoveryBtn = document.createElement('div');
    recoveryBtn.id = 'manga-translator-recovery';
    Object.assign(recoveryBtn.style, {
      position: 'fixed',
      left: btnLeft + 'px',
      top: btnTop + 'px',
      width: btnWidth + 'px',
      height: btnHeight + 'px',
      background: 'transparent',
      zIndex: 999998,
      cursor: 'default',
      pointerEvents: 'auto'
    });
    document.body.appendChild(recoveryBtn);
    recoveryBtn.addEventListener('click', function showAgain() {
      floatBtn.style.display = 'flex';
      recoveryBtn.remove();
    });
  }

  let isDragging = false, hasMoved = false;
  let startX, startY, startLeft, startTop;
  const moveThreshold = 2;

  floatBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    isDragging = true;
    hasMoved = false;
    const rect = floatBtn.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    floatBtn.setPointerCapture(e.pointerId);
    floatBtn.style.cursor = 'grabbing';
  });

  floatBtn.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > moveThreshold || Math.abs(dy) > moveThreshold) hasMoved = true;
    let newLeft = startLeft + dx;
    let newTop = startTop + dy;
    newLeft = Math.max(0, Math.min(window.innerWidth - floatBtn.offsetWidth, newLeft));
    newTop = Math.max(0, Math.min(window.innerHeight - floatBtn.offsetHeight, newTop));
    floatBtn.style.left = newLeft + 'px';
    floatBtn.style.top = newTop + 'px';
    menu.style.display = 'none';
    progressEl.style.display = 'none';
  });

  floatBtn.addEventListener('pointerup', async (e) => {
    if (!isDragging) return;
    floatBtn.releasePointerCapture(e.pointerId);
    floatBtn.style.cursor = 'grab';
    if (hasMoved) {
      const rect = floatBtn.getBoundingClientRect();
      await chrome.storage.local.set({ floatPos: { left: rect.left, top: rect.top } });
    } else {
      if (menu.style.display === 'block') {
        menu.style.display = 'none';
      } else {
        await populateMenu();
        // 预设隐藏并显示以获取准确尺寸
        menu.style.visibility = 'hidden';
        menu.style.display = 'block';
        const menuWidth = menu.offsetWidth;
        const menuHeight = menu.offsetHeight;
        menu.style.display = 'none';
        menu.style.visibility = 'visible';

        const btnRect = floatBtn.getBoundingClientRect();
        const btnCenterX = btnRect.left + btnRect.width / 2;
        const btnCenterY = btnRect.top + btnRect.height / 2;
        const isLeft = btnCenterX < window.innerWidth / 2;
        const isTop = btnCenterY < window.innerHeight / 2;

        let left, top;
        if (isLeft && isTop) { left = btnRect.right + 5; top = btnRect.top; }
        else if (isLeft && !isTop) { left = btnRect.right + 5; top = btnRect.bottom - menuHeight; }
        else if (!isLeft && isTop) { left = btnRect.left - menuWidth - 5; top = btnRect.top; }
        else { left = btnRect.left - menuWidth - 5; top = btnRect.bottom - menuHeight; }

        left = Math.max(5, Math.min(left, window.innerWidth - menuWidth - 5));
        top = Math.max(5, Math.min(top, window.innerHeight - menuHeight - 5));

        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.style.display = 'block';
      }
    }
    isDragging = false;
  });

  floatBtn.addEventListener('pointercancel', () => {
    floatBtn.releasePointerCapture(e.pointerId);
    floatBtn.style.cursor = 'grab';
    isDragging = false;
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== floatBtn) {
      menu.style.display = 'none';
    }
  });

  function startTranslationWithProgress() {
    const btnRect = floatBtn.getBoundingClientRect();
    progressEl.style.left = btnRect.left + 'px';
    progressEl.style.top = (btnRect.bottom + 5) + 'px';
    progressEl.style.display = 'block';
    progressEl.textContent = '0/0';
    translateAllImages((completed, total) => {
      progressEl.textContent = `${completed}/${total}`;
      if (completed === total || stopTranslation) {
        setTimeout(() => progressEl.style.display = 'none', 2000);
      }
    });
  }

  function updateFloatingIconStyle(changes) {
    const btn = document.getElementById('manga-translator-float');
    if (!btn) return;
    if (changes.floatIconUrl) {
      if (changes.floatIconUrl.newValue) {
        btn.style.backgroundImage = `url(${changes.floatIconUrl.newValue})`;
        btn.textContent = '';
      } else {
        btn.style.backgroundImage = 'none';
        btn.textContent = '📖';
      }
    }
    if (changes.floatIconWidth) btn.style.width = changes.floatIconWidth.newValue + 'px';
    if (changes.floatIconHeight) btn.style.height = changes.floatIconHeight.newValue + 'px';
  }
}

async function restoreFloatPosition(floatBtn) {
  const { floatPos } = await chrome.storage.local.get('floatPos');
  if (floatPos) {
    floatBtn.style.left = floatPos.left + 'px';
    floatBtn.style.top = floatPos.top + 'px';
  }
}

// ===================== 调试工具 =====================
window.__mangaDebug = {
  getCache() {
    console.table(Array.from(translationCache.entries()).map(([url, result]) => ({ url, result })));
  },
  clearCache() {
    translationCache.clear();
    imageTranslationMap.clear();
    console.log('缓存已清除');
  },
  getPending() {
    console.log('待处理请求:', Array.from(pendingRequests.keys()));
  },
  getFailedImages() {
    console.table(Array.from(failedImages.entries()).map(([url, item]) => ({ url, retryCount: item.retryCount })));
  },
  async getMode(mode) {
    if (mode) {
      await chrome.storage.sync.set({ translationMode: mode });
      console.log('已切换模式:', mode);
    } else {
      const { translationMode } = await chrome.storage.sync.get('translationMode');
      console.log('当前模式:', translationMode);
    }
  },
  getRetryLimit() {
    console.log('重试上限:', currentRetryLimit);
  },
  capture() {
    chrome.runtime.sendMessage({ action: 'captureAndTranslate' });
    console.log('截屏翻译已触发');
  },
  stop() {
    stopTranslation = true;
    console.log('已发送停止信号');
  },
  help() {
    console.log(`可用命令:
  getCache() / clearCache()
  getPending() / getFailedImages()
  getMode() / getMode('vision|ocr|rerank')
  getRetryLimit()
  capture()
  stop()
  help()`);
  }
};

// ===================== 监听新增图片，自动恢复翻译框 =====================
const imageObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeName === 'IMG' && node.src) {
        const cached = imageTranslationMap.get(node.src);
        if (cached && !node.parentNode?.classList?.contains('translation-wrapper')) {
          const wrapper = ensureWrapper(node);
          applyTranslationResult(wrapper, cached);
        }
      }
    }
  }
});
imageObserver.observe(document.body, { childList: true, subtree: true });

// 启动悬浮按钮
initFloatingButton();