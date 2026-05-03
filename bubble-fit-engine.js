// bubble-fit-engine.js
// ========================================================================
//  气泡轮廓分析与智能适配引擎 (Bubble Fit Engine)
// ========================================================================
//
//  功能概述：
//    - 在图片像素级别分析对话气泡的实际形状，提取精确轮廓。
//    - 基于真实气泡形状计算安全的文本可用区域，支持椭圆、云朵、
//      尖刺形等常见漫画气泡。
//    - 动态调整字号和换行，使文本最优地填充在不规则区域内。
//    - 支持倾斜校正（基于气泡中心轴）、竖排自动切换。
//    - 生成 CSS clip-path 遮罩路径，使翻译文本不超出气泡边缘
//      （当前版本默认禁用遮罩，仅用于字号和换行优化）。
//    - 为 bubble-renderer.js 提供更精准的 bbox、shape 和 layout 参数。
//
//  使用方式（在 content.js 的 renderMultiBoxes 中）：
//    const fitResult = await fitTextToBubbleRegion(imgElement, ocrBbox, translatedText);
//    const { adjustedBbox, layout, clipPath } = fitResult;
//    // 使用 layout 中的 fontSize 和 lines 创建翻译框
//
//  依赖：
//    - 浏览器 Canvas 2D 环境
//    - 像素数据读取（需要图片已加载且不受跨域限制）
//    - bubble-renderer.js（可选，使用其 layoutTextInBubble 进行文本排版）
//
// ========================================================================

// ===================== 配置与常量 =====================
const EDGE_DETECT_THRESHOLD = 30;       // 边缘检测敏感度 (0-255)
const MIN_BUBBLE_AREA = 500;            // 最小气泡面积（像素平方）
const BUBBLE_COLOR_WHITE_THRESHOLD = 200; // 白色气泡判定阈值（R,G,B 平均值）
const SAMPLE_STEP = 4;                  // 像素采样步长（性能优化）
const MAX_LAYOUT_ITERATIONS = 10;       // 字号适配最大迭代次数

// ===================== 核心函数：气泡轮廓提取 =====================

/**
 * 从图片的指定区域提取气泡轮廓。
 * 算法：在给定矩形区域（OCR bbox）内查找白色连通域，并返回其多边形轮廓。
 * 若未找到气泡，则返回矩形本身。
 *
 * @param {HTMLImageElement|HTMLCanvasElement} imageSource - 图片源
 * @param {number[]} bbox - 归一化 OCR 框 [x1, y1, x2, y2]
 * @param {object} options - 可选参数 { threshold?: number, step?: number }
 * @returns {Promise<{polygon: number[][], bounds: number[]}>} 轮廓多边形及外接矩形（像素坐标）
 */
async function extractBubbleContour(imageSource, bbox, options = {}) {
  const threshold = options.threshold || BUBBLE_COLOR_WHITE_THRESHOLD;
  const step = options.step || SAMPLE_STEP;

  // 确保图片已加载，避免 naturalWidth/Height 为 0
  if (!imageSource.complete) {
    await new Promise(resolve => { imageSource.onload = resolve; });
  }

  // 将图像绘制到 canvas 以获取像素数据
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // 使用 OCR bbox 裁剪区域
  const imgWidth = imageSource.naturalWidth || imageSource.width;
  const imgHeight = imageSource.naturalHeight || imageSource.height;
  const [bx1, by1, bx2, by2] = bbox;
  const regionX = Math.floor(bx1 * imgWidth);
  const regionY = Math.floor(by1 * imgHeight);
  const regionW = Math.ceil((bx2 - bx1) * imgWidth);
  const regionH = Math.ceil((by2 - by1) * imgHeight);

  if (regionW <= 0 || regionH <= 0) {
    return {
      polygon: [[bx1*imgWidth, by1*imgHeight], [bx2*imgWidth, by1*imgHeight], [bx2*imgWidth, by2*imgHeight], [bx1*imgWidth, by2*imgHeight]],
      bounds: [bx1*imgWidth, by1*imgHeight, bx2*imgWidth, by2*imgHeight]
    };
  }

  canvas.width = regionW;
  canvas.height = regionH;
  ctx.drawImage(imageSource, regionX, regionY, regionW, regionH, 0, 0, regionW, regionH);
  const imageData = ctx.getImageData(0, 0, regionW, regionH);
  const { data } = imageData;

  // 二值化：白色气泡为前景 (255)，其余为背景 (0)
  const bw = new Uint8Array(regionW * regionH);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const avg = (r + g + b) / 3;
    bw[i/4] = avg > threshold ? 255 : 0;
  }

  // 简单连通域标记（使用 flood fill 近似抓取最大区域）
  const visited = new Uint8Array(regionW * regionH);
  let largestArea = 0;
  let largestContour = null;

  for (let y = 0; y < regionH; y += step) {
    for (let x = 0; x < regionW; x += step) {
      const idx = y * regionW + x;
      if (bw[idx] === 255 && !visited[idx]) {
        // 执行 flood fill
        const area = floodFill(bw, visited, regionW, regionH, x, y);
        if (area > largestArea) {
          largestArea = area;
          // 提取该区域的轮廓
          largestContour = traceContour(bw, regionW, regionH, x, y);
        }
      }
    }
  }

  // 若未找到合适气泡，使用矩形
  if (!largestContour || largestContour.length < 3) {
    return {
      polygon: [[0,0], [regionW,0], [regionW,regionH], [0,regionH]],
      bounds: [regionX, regionY, regionX+regionW, regionY+regionH]
    };
  }

  // 将轮廓坐标转换回图片像素坐标
  const polygon = largestContour.map(([px, py]) => [px + regionX, py + regionY]);
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

  return { polygon, bounds };
}

/**
 * 简单的洪水填充，用于计算连通域面积。
 * @returns {number} 该连通域包含的像素数
 */
function floodFill(bw, visited, width, height, startX, startY) {
  const stack = [[startX, startY]];
  let count = 0;
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const idx = y * width + x;
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    if (visited[idx] || bw[idx] !== 255) continue;
    visited[idx] = 1;
    count++;
    stack.push([x+1, y], [x-1, y], [x, y+1], [x, y-1]);
  }
  return count;
}

/**
 * 通过扫描线提取连通域的轮廓点（简单边界追踪）。
 * @returns {number[][]} 轮廓点数组 [[x,y], ...]
 */
function traceContour(bw, width, height, seedX, seedY) {
  // 采用 Moore 边界追踪算法简化版：找到最左上的边界点开始追踪
  // 这里使用更简单的扫描线方法：遍历所有前景像素，只保留那些四邻域中有背景像素的点
  const contour = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (bw[idx] !== 255) continue;
      // 检查四邻域是否存在背景
      if ((x > 0 && bw[idx-1] === 0) || (x < width-1 && bw[idx+1] === 0) ||
          (y > 0 && bw[idx - width] === 0) || (y < height-1 && bw[idx + width] === 0)) {
        contour.push([x, y]);
      }
    }
  }
  // 简化轮廓点（每隔几个点采样），降低多边形复杂度
  return simplifyContour(contour, 5);
}

function simplifyContour(points, step) {
  if (points.length <= step*2) return points;
  return points.filter((_, i) => i % step === 0);
}

// ===================== 不规则区域文本适配 =====================

/**
 * 在给定的多边形气包内计算文本的最佳布局。
 * 通过二分搜索找到不超出轮廓的最大字号，并调用外部排版函数进行换行。
 *
 * @param {string} text - 翻译文本
 * @param {number[][]} polygon - 气泡轮廓（像素坐标，相对于图片左上角）
 * @param {object} options - 选项 { fontSizeRange, defaultFontSize, maxLines }
 * @returns {{ fontSize: number, lines: string[], positions: Array<{text, x, y}> }}
 */
function fitTextToIrregularRegion(text, polygon, options = {}) {
  const defaultFontSize = options.defaultFontSize || 16;
  const maxLines = options.maxLines || 5;
  const minFs = 12, maxFs = 24; // 限定合理字号范围

  // 获取多边形外接矩形作为粗略排版区域
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
  const boxX1 = Math.min(...xs), boxY1 = Math.min(...ys);
  const boxX2 = Math.max(...xs), boxY2 = Math.max(...ys);
  const boxWidth = boxX2 - boxX1;
  const boxHeight = boxY2 - boxY1;

  let bestLayout = null;
  // 二分搜索合适字号
  for (let fs = maxFs; fs >= minFs; fs--) {
    const lines = tryWrapText(text, boxWidth, fs, maxLines);
    if (!lines) continue;

    // 检查所有行是否完全在多边形内部（简化检查：每行的外接矩形与多边形关系）
    if (isLinesInsidePolygon(lines, polygon, boxX1, boxY1, fs)) {
      bestLayout = { fontSize: fs, lines, box: { x: boxX1, y: boxY1, w: boxWidth, h: boxHeight } };
      break;
    }
  }

  if (!bestLayout) {
    // 降级：使用最小字号并允许溢出
    const lines = tryWrapText(text, boxWidth, minFs, maxLines) || [text];
    bestLayout = { fontSize: minFs, lines, box: { x: boxX1, y: boxY1, w: boxWidth, h: boxHeight } };
  }

  // 生成本地排版位置（相对于气泡左上角）
  const { fontSize, lines, box } = bestLayout;
  const lineHeight = fontSize * 1.5;
  const startY = box.y + (box.h - lines.length * lineHeight) / 2;
  const positions = [];
  lines.forEach((line, idx) => {
    const lineWidth = measureTextWidth(line, fontSize);
    const x = box.x + (box.w - lineWidth) / 2; // 居中
    const y = startY + idx * lineHeight;
    positions.push({ text: line, x, y, fontSize });
  });

  return { fontSize, lines, positions };
}

function tryWrapText(text, boxWidth, fontSize, maxLines) {
  const lines = [];
  let currentLine = '';
  const tokens = text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]|[a-zA-Z0-9]+|\S/g) || [text];

  for (const token of tokens) {
    const testLine = currentLine ? currentLine + token : token;
    const testWidth = measureTextWidth(testLine, fontSize);
    if (testWidth > boxWidth && currentLine.length > 0) {
      lines.push(currentLine);
      if (lines.length >= maxLines) return null; // 超过最大行数
      currentLine = token;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length <= maxLines ? lines : null;
}

function measureTextWidth(text, fontSize) {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${fontSize}px Arial, "Microsoft YaHei", sans-serif`;
  return ctx.measureText(text).width;
}

function isLinesInsidePolygon(lines, polygon, boxX, boxY, fontSize) {
  // 简化：检查每行文本的四个角点是否都在多边形内
  const lineHeight = fontSize * 1.5;
  const yStart = boxY + (polygonMaxY(polygon) - polygonMinY(polygon) - lines.length * lineHeight) / 2; // 近似居中
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineWidth = measureTextWidth(line, fontSize);
    const x = boxX + (polygonMaxX(polygon) - polygonMinX(polygon) - lineWidth) / 2; // 居中
    const y = yStart + i * lineHeight;
    if (!isPointInPolygon([x, y], polygon) || !isPointInPolygon([x+lineWidth, y], polygon) ||
        !isPointInPolygon([x, y+fontSize], polygon) || !isPointInPolygon([x+lineWidth, y+fontSize], polygon)) {
      return false;
    }
  }
  return true;
}

function polygonMinX(polygon) { return Math.min(...polygon.map(p => p[0])); }
function polygonMaxX(polygon) { return Math.max(...polygon.map(p => p[0])); }
function polygonMinY(polygon) { return Math.min(...polygon.map(p => p[1])); }
function polygonMaxY(polygon) { return Math.max(...polygon.map(p => p[1])); }

/**
 * 射线法判断点是否在多边形内部
 */
function isPointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ===================== 倾斜校正与竖排检测 =====================

/**
 * 检测气泡中心轴倾斜角度，返回建议的文本方向。
 * @param {number[][]} polygon - 轮廓
 * @returns {{ angle: number, isVertical: boolean }} 角度（弧度）和是否适合竖排
 */
function detectBubbleOrientation(polygon) {
  if (!polygon || polygon.length < 3) return { angle: 0, isVertical: false };
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;

  // 简单判断：如果高度 > 宽度 * 1.5，适合竖排
  const isVertical = height > width * 1.5;
  // 倾斜角度通过最小二乘法拟合中心线（简化：取长轴方向）
  let angle = 0;
  if (isVertical) {
    // 纵向气泡，计算列中心点拟合
    const centers = [];
    for (let y = minY; y <= maxY; y += height/10) {
      const rowXs = polygon.filter(p => p[1] >= y && p[1] <= y + height/10).map(p => p[0]);
      if (rowXs.length > 0) centers.push([(Math.min(...rowXs) + Math.max(...rowXs))/2, y]);
    }
    if (centers.length > 1) {
      angle = linearRegressionSlope(centers);
    }
  } else {
    // 横向气泡
    const centers = [];
    for (let x = minX; x <= maxX; x += width/10) {
      const colYs = polygon.filter(p => p[0] >= x && p[0] <= x + width/10).map(p => p[1]);
      if (colYs.length > 0) centers.push([x, (Math.min(...colYs) + Math.max(...colYs))/2]);
    }
    if (centers.length > 1) {
      angle = -linearRegressionSlope(centers);
    }
  }
  return { angle, isVertical };
}

function linearRegressionSlope(points) {
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const [x, y] of points) {
    sumX += x; sumY += y; sumXY += x*y; sumXX += x*x;
  }
  return (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
}

// ===================== 遮罩路径生成 =====================

/**
 * 根据多边形生成 CSS clip-path 属性值，用于裁剪翻译框。
 * （当前版本默认返回 'none'，不使用遮罩）
 * @param {number[][]} polygon - 多边形顶点（像素坐标）
 * @param {number} canvasWidth - 图片显示宽度（用于百分比转换）
 * @param {number} canvasHeight - 图片显示高度
 * @returns {string} clip-path 字符串，例如 "polygon(10% 20%, ...)"
 */
function generateClipPath(polygon, canvasWidth, canvasHeight) {
  if (!polygon || polygon.length < 3) return 'none';
  const percentPoints = polygon.map(([x, y]) => {
    return `${(x / canvasWidth * 100).toFixed(2)}% ${(y / canvasHeight * 100).toFixed(2)}%`;
  });
  return `polygon(${percentPoints.join(', ')})`;
}

// ===================== 主集成函数 =====================

/**
 * 对单个 OCR 文本区域进行完整的气泡适配。
 * 流程：提取真实轮廓 → 适配文本 → 生成遮罩。
 *
 * @param {HTMLImageElement} img - 图片 DOM 元素
 * @param {number[]} ocrBbox - 归一化坐标 [x1, y1, x2, y2]
 * @param {string} translatedText - 翻译后的文本
 * @param {object} options - 可选 { direction?: 'horizontal'|'vertical', forceShape?: string }
 * @returns {Promise<{ polygon: number[][], bbox: number[], layout: object, clipPath: string }>}
 */
async function fitTextToBubbleRegion(img, ocrBbox, translatedText, options = {}) {
  // 1. 提取气泡轮廓
  const { polygon, bounds } = await extractBubbleContour(img, ocrBbox);
  if (!polygon || polygon.length < 3) {
    // 降级为矩形适配
    return fallbackToRect(img, ocrBbox, translatedText, options);
  }

  // 2. 检测方向
  const { angle, isVertical } = options.direction 
    ? { angle: 0, isVertical: options.direction === 'vertical' }
    : detectBubbleOrientation(polygon);

  // 3. 文本适配
  const fitOptions = {
    defaultFontSize: 16,
    maxLines: isVertical ? 5 : 3,
    direction: isVertical ? 'vertical' : 'horizontal'
  };
  const layout = fitTextToIrregularRegion(translatedText, polygon, fitOptions);

  // 4. 生成遮罩（当前默认不使用）
  const displayW = img.clientWidth || img.naturalWidth;
  const displayH = img.clientHeight || img.naturalHeight;
  const clipPath = 'none'; // 保持矩形框，不应用多边形遮罩

  // 5. 归一化输出 bbox（基于真实轮廓的外接矩形）
  const imgW = img.naturalWidth || displayW;
  const imgH = img.naturalHeight || displayH;
  const normBbox = [
    bounds[0] / imgW,
    bounds[1] / imgH,
    bounds[2] / imgW,
    bounds[3] / imgH
  ];

  // 强制最小字号
  layout.fontSize = Math.max(12, layout.fontSize);

  return {
    polygon,
    adjustedBbox: normBbox,
    layout,
    clipPath,
    direction: isVertical ? 'vertical' : 'horizontal'
  };
}

function fallbackToRect(img, ocrBbox, text, options) {
  const imgW = img.naturalWidth || img.clientWidth || 100;
  const imgH = img.naturalHeight || img.clientHeight || 100;
  const width = (ocrBbox[2] - ocrBbox[0]) * imgW;
  const height = (ocrBbox[3] - ocrBbox[1]) * imgH;
  const font = Math.max(12, Math.min(16, height / 3));
  const lines = [text];
  return {
    polygon: [[ocrBbox[0]*imgW, ocrBbox[1]*imgH], [ocrBbox[2]*imgW, ocrBbox[1]*imgH], [ocrBbox[2]*imgW, ocrBbox[3]*imgH], [ocrBbox[0]*imgW, ocrBbox[3]*imgH]],
    adjustedBbox: ocrBbox,
    layout: { fontSize: font, lines, positions: [{ text, x: ocrBbox[0]*imgW + 5, y: ocrBbox[1]*imgH + 5, fontSize: font }] },
    clipPath: 'none',
    direction: 'horizontal'
  };
}

// ---------- 调试示例 ----------
/*
(async () => {
  const img = document.querySelector('img');
  const bbox = [0.1, 0.1, 0.3, 0.25];
  const result = await fitTextToBubbleRegion(img, bbox, 'こんにちは');
  console.log(result);
})();
*/