// bubble-renderer.js
// ========================================================================
//  气泡文本智能排版模块 (Bubble Text Intelligent Renderer)
// ========================================================================
//
//  功能概述：
//    - 对漫画中的对话气泡进行文本排版，使翻译文字自然贴合气泡。
//    - 实现自适应换行、字体缩放、水平/垂直对齐、竖排文字处理。
//    - 支持不同气泡形状（矩形、圆角矩形、椭圆、菱形、对话框状等）。
//    - 提供丰富的预设样式（经典漫画、网漫、竖排等），并支持自定义。
//    - 包含两端对齐算法（通过字间距微调），使排版更加整齐。
//    - 所有计算均基于 Canvas 2D 文本测量，保证精确。
//
//  使用方式：
//    在 content.js 中调用：
//      const layout = layoutTextInBubble(text, bbox, options);
//      layout.items 为 [{ text, x, y, fontSize }] 数组，
//      可直接用于 Canvas 绘图或生成 DOM 元素。
//
//  依赖：
//    需要在浏览器环境中运行（需要 Canvas 2D 上下文）。
//    在 Chrome 扩展的 content script 中可直接使用。
//
//  注意：
//    所有坐标均为相对于图片左上角的像素值。
//    bbox 格式为 [x1, y1, x2, y2]，归一化坐标（0~1）。
//
// ========================================================================

// ===================== 常量与默认参数 =====================
const FONT_FAMILY = 'Arial, "Microsoft YaHei", sans-serif';
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const FONT_SIZE_STEP = 1;
const MAX_LINES = 5;
const PADDING_HORIZONTAL = 4;
const PADDING_VERTICAL = 4;
const LINE_HEIGHT_RATIO = 1.5;
// 共享 Canvas 上下文，用于文本宽度测量
const TEXT_MEASURE_CTX = document.createElement('canvas').getContext('2d');

// ===================== 文本测量工具 =====================

/**
 * 获取指定文本在特定字号下的渲染宽度（像素）
 * @param {string} text - 待测量文本
 * @param {number} fontSize - 字号（px）
 * @param {string} fontWeight - 字重，如 'normal'、'bold'
 * @returns {number} 文本宽度
 */
function measureTextWidth(text, fontSize, fontWeight = 'normal') {
  TEXT_MEASURE_CTX.font = `${fontWeight} ${fontSize}px ${FONT_FAMILY}`;
  return TEXT_MEASURE_CTX.measureText(text).width;
}

/**
 * 计算指定字号的行高
 * @param {number} fontSize - 字号（px）
 * @returns {number} 行高（px）
 */
function getLineHeight(fontSize) {
  return fontSize * LINE_HEIGHT_RATIO;
}

// ===================== 文本自动换行算法 =====================

/**
 * 将文本按照气泡可用宽度拆分成多行。
 * 对中文/日文/韩文按字符拆分，英文/数字按单词拆分，
 * 在宽度超出时另起一行。
 *
 * @param {string} text - 原始文本
 * @param {number} maxWidth - 每行最大宽度（像素）
 * @param {number} fontSize - 当前字号
 * @returns {string[]} 分行后的文本数组
 */
function wrapTextToLines(text, maxWidth, fontSize) {
  if (!text) return [];

  const lines = [];
  let currentLine = '';

  // 将文本分割为 token 序列：CJK 字符单独一个 token，连续字母数字为一个 token，
  // 其他符号单独 token
  const tokens = text.match(
    /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]|[a-zA-Z0-9]+|\S/g
  ) || [text];

  for (const token of tokens) {
    const testLine = currentLine ? currentLine + token : token;
    const testWidth = measureTextWidth(testLine, fontSize);

    if (testWidth > maxWidth && currentLine.length > 0) {
      // 当前行已满，保存，另起一行
      lines.push(currentLine);
      currentLine = token;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}

// ===================== 字体大小自适应逻辑 =====================

/**
 * 根据气泡可用尺寸，自动寻找合适的字号，使文本能完全容纳。
 * 算法：从起始字号逐级减小，直到文本行数不超过最大行数且总高度不超过气泡。
 *
 * @param {string} text - 原始文本
 * @param {number} boxWidth - 气泡内部可用宽度（像素）
 * @param {number} boxHeight - 气泡内部可用高度（像素）
 * @param {number} startFontSize - 起始字号
 * @param {number} maxLines - 允许的最大行数
 * @returns {{ fontSize: number, lines: string[] }} 最终字号和分行结果
 */
function fitTextToBox(text, boxWidth, boxHeight, startFontSize = DEFAULT_FONT_SIZE, maxLines = MAX_LINES) {
  let fontSize = startFontSize;
  let lines = [];

  while (fontSize >= MIN_FONT_SIZE) {
    const availableWidth = boxWidth - PADDING_HORIZONTAL * 2;
    lines = wrapTextToLines(text, availableWidth, fontSize);

    const lineHeight = getLineHeight(fontSize);
    const totalHeight = lines.length * lineHeight + PADDING_VERTICAL * 2;

    if (lines.length <= maxLines && totalHeight <= boxHeight) {
      return { fontSize, lines };
    }
    fontSize -= FONT_SIZE_STEP;
  }

  // 最小字号仍放不下：使用最小字号，可能裁剪
  const availableWidth = boxWidth - PADDING_HORIZONTAL * 2;
  lines = wrapTextToLines(text, availableWidth, MIN_FONT_SIZE);
  return { fontSize: MIN_FONT_SIZE, lines };
}

// ===================== 水平对齐策略 =====================

/**
 * 计算每行文本相对于气泡左边缘的 X 坐标。
 * 支持左对齐、居中、右对齐以及两端对齐。
 * 两端对齐会在单词/字符间插入额外间距，使每行两端边缘与气泡对齐。
 *
 * @param {string[]} lines - 文本行数组
 * @param {number} boxWidth - 气泡宽度
 * @param {number} fontSize - 字号
 * @param {string} align - 'left' | 'center' | 'right' | 'justify'
 * @returns {{ positions: number[], spacings: number[] }} positions 为每行起始 X，
 *          spacings 为每行额外字间距（仅 justify 有效）
 */
function computeHorizontalPositions(lines, boxWidth, fontSize, align = 'center') {
  const availableWidth = boxWidth - PADDING_HORIZONTAL * 2;
  const positions = [];
  const spacings = new Array(lines.length).fill(0);

  if (align === 'justify') {
    // 两端对齐：计算每行需要插入的额外间距，均匀分布在字符/单词之间
    lines.forEach((line, idx) => {
      const lineWidth = measureTextWidth(line, fontSize);
      const gapCount = line.length - 1; // 字符/单词间的间隙数
      if (gapCount > 0) {
        const extraGap = (availableWidth - lineWidth) / gapCount;
        spacings[idx] = Math.max(0, extraGap);
        positions[idx] = PADDING_HORIZONTAL;
      } else {
        positions[idx] = (boxWidth - lineWidth) / 2;
      }
    });
  } else {
    // 普通对齐
    lines.forEach(line => {
      const lineWidth = measureTextWidth(line, fontSize);
      switch (align) {
        case 'left':
          positions.push(PADDING_HORIZONTAL);
          break;
        case 'right':
          positions.push(boxWidth - PADDING_HORIZONTAL - lineWidth);
          break;
        case 'center':
        default:
          positions.push((boxWidth - lineWidth) / 2);
      }
    });
  }
  return { positions, spacings };
}

// ===================== 垂直对齐策略 =====================

/**
 * 计算文本块在气泡内的起始 Y 坐标，实现垂直方向对齐。
 * @param {string[]} lines - 文本行数组
 * @param {number} boxHeight - 气泡高度
 * @param {number} fontSize - 字号
 * @param {string} verticalAlign - 'top' | 'middle' | 'bottom'
 * @returns {number} 第一行文本的顶部 Y 坐标
 */
function computeVerticalStartY(lines, boxHeight, fontSize, verticalAlign = 'middle') {
  const lineHeight = getLineHeight(fontSize);
  const totalTextHeight = lines.length * lineHeight;
  switch (verticalAlign) {
    case 'top':
      return PADDING_VERTICAL;
    case 'bottom':
      return boxHeight - PADDING_VERTICAL - totalTextHeight;
    case 'middle':
    default:
      return (boxHeight - totalTextHeight) / 2;
  }
}

// ===================== 竖排文字排版 =====================

/**
 * 将文本转换为竖排模式，返回列数组（从右向左）。
 * 每个子数组为从上到下的字符序列。
 * @param {string} text - 原文
 * @param {number} maxHeight - 气泡可用高度（像素）
 * @param {number} fontSize - 字号
 * @returns {{ columns: string[][], columnWidth: number }} 列数据及列宽
 */
function layoutVerticalText(text, maxHeight, fontSize) {
  const columnWidth = fontSize * 1.2;
  const chars = text.split('');
  const columns = [];
  let currentColumn = [];
  let currentHeight = 0;

  for (const char of chars) {
    if (currentHeight + fontSize > maxHeight - PADDING_VERTICAL * 2) {
      columns.push(currentColumn);
      currentColumn = [char];
      currentHeight = fontSize;
    } else {
      currentColumn.push(char);
      currentHeight += fontSize;
    }
  }
  if (currentColumn.length > 0) columns.push(currentColumn);
  return { columns, columnWidth };
}

/**
 * 计算竖排文本中每个字符的绘制坐标（相对于气泡左上角）
 * @param {string[][]} columns - 列数据
 * @param {number} boxWidth - 气泡宽度
 * @param {number} boxHeight - 气泡高度
 * @param {number} fontSize - 字号
 * @param {string} horizontalAlign - 水平对齐
 * @param {string} verticalAlign - 垂直对齐
 * @returns {Array<{char: string, x: number, y: number, fontSize: number}>} 字符位置数组
 */
function computeVerticalCharPositions(columns, boxWidth, boxHeight, fontSize,
  horizontalAlign = 'center', verticalAlign = 'middle') {
  const columnWidth = fontSize * 1.2;
  const totalColumnsWidth = columns.length * columnWidth;

  let startX;
  switch (horizontalAlign) {
    case 'left':
      startX = PADDING_HORIZONTAL;
      break;
    case 'right':
      startX = boxWidth - PADDING_HORIZONTAL - totalColumnsWidth;
      break;
    case 'center':
    default:
      startX = (boxWidth - totalColumnsWidth) / 2;
  }

  let startY;
  const maxColumnLength = Math.max(...columns.map(c => c.length));
  const totalTextHeight = maxColumnLength * fontSize;
  switch (verticalAlign) {
    case 'top':
      startY = PADDING_VERTICAL;
      break;
    case 'bottom':
      startY = boxHeight - PADDING_VERTICAL - totalTextHeight;
      break;
    case 'middle':
    default:
      startY = (boxHeight - totalTextHeight) / 2;
  }

  const positions = [];
  for (let colIndex = 0; colIndex < columns.length; colIndex++) {
    const column = columns[colIndex];
    const colX = startX + (columns.length - 1 - colIndex) * columnWidth;
    for (let charIndex = 0; charIndex < column.length; charIndex++) {
      positions.push({
        char: column[charIndex],
        x: colX,
        y: startY + charIndex * fontSize,
        fontSize
      });
    }
  }
  return positions;
}

// ===================== 气泡形状安全区域计算 =====================

/**
 * 根据气泡形状，计算内部文本的安全可用区域。
 * 不同形状会有不同的内边距和偏移。
 * @param {string} shape - 形状类型
 * @param {number} boxWidth - 气泡外框宽度
 * @param {number} boxHeight - 气泡外框高度
 * @returns {{ width: number, height: number, offsetX: number, offsetY: number }}
 */
function getSafeTextAreaForShape(shape, boxWidth, boxHeight) {
  let hPad = PADDING_HORIZONTAL;
  let vPad = PADDING_VERTICAL;
  let offX = hPad;
  let offY = vPad;

  switch (shape) {
    case 'rectangle':
      break;
    case 'rounded':
      hPad += 6;
      vPad += 6;
      offX = hPad;
      offY = vPad;
      break;
    case 'ellipse':
      hPad = boxWidth * 0.15;
      vPad = boxHeight * 0.2;
      offX = hPad;
      offY = vPad;
      break;
    case 'diamond':
      // 菱形可用区域：中心矩形，各方向留出约 25% 边距
      hPad = boxWidth * 0.25;
      vPad = boxHeight * 0.25;
      offX = hPad;
      offY = vPad;
      break;
    case 'cloud':
      // 云形气泡：边缘不规则，加额外不规则的边距
      hPad = boxWidth * 0.2;
      vPad = boxHeight * 0.25;
      offX = hPad;
      offY = vPad;
      break;
    case 'thought':
      // 思考气泡：小气泡链在底部，顶部留更多空间
      hPad = boxWidth * 0.1;
      vPad = boxHeight * 0.3;
      offX = hPad;
      offY = vPad * 0.5;
      break;
    default:
      break;
  }
  return {
    width: boxWidth - hPad * 2,
    height: boxHeight - vPad * 2,
    offsetX: offX,
    offsetY: offY
  };
}

// ===================== 两端对齐渲染辅助 =====================

/**
 * 将一行文本按照两端对齐时的额外间距拆分为带有定位的字符段。
 * 用于在 Canvas 或 DOM 中精确绘制。
 * @param {string} line - 一行文本
 * @param {number} startX - 行起始 X
 * @param {number} y - 行 Y 坐标
 * @param {number} fontSize - 字号
 * @param {number} extraGap - 字符间额外间距
 * @returns {Array<{char: string, x: number, y: number, fontSize: number}>} 字符位置数组
 */
function generateJustifiedCharPositions(line, startX, y, fontSize, extraGap) {
  const positions = [];
  let cursorX = startX;
  for (const char of line) {
    positions.push({ char, x: cursorX, y, fontSize });
    cursorX += measureTextWidth(char, fontSize) + extraGap;
  }
  return positions;
}

// ===================== 主排版函数 =====================

/**
 * 计算文本在气泡内的完整布局信息。
 *
 * @param {string} text - 要排版的文本
 * @param {number[]} bbox - 气泡在图片上的归一化边界框 [x1, y1, x2, y2]
 * @param {object} options - 布局选项
 * @param {string} [options.direction='horizontal'] - 文字方向 'horizontal' | 'vertical'
 * @param {string} [options.shape='rectangle'] - 气泡形状，如 'rectangle' 'rounded' 'ellipse' 'diamond' 'cloud' 'thought'
 * @param {string} [options.horizontalAlign='center'] - 水平对齐 'left'|'center'|'right'|'justify'
 * @param {string} [options.verticalAlign='middle'] - 垂直对齐 'top'|'middle'|'bottom'
 * @param {number} [options.fontSizeOverride] - 强制字号，不填则自适应
 * @param {number} [options.maxLines=5] - 最大行数
 * @param {number} options.imgWidth - 图片宽度（像素），用于坐标转换
 * @param {number} options.imgHeight - 图片高度（像素）
 * @param {string} [options.fontWeight='normal'] - 字重
 * @returns {{ items: Array, fontSize: number, linesCount: number, isVertical: boolean }}
 *          items 为绘制元素数组，每个元素包含 text, x, y, fontSize
 */
function layoutTextInBubble(text, bbox, options = {}) {
  const {
    direction = 'horizontal',
    shape = 'rectangle',
    horizontalAlign = 'center',
    verticalAlign = 'middle',
    fontSizeOverride,
    maxLines = MAX_LINES,
    imgWidth,
    imgHeight,
    fontWeight = 'normal'
  } = options;

  if (!imgWidth || !imgHeight) {
    throw new Error('layoutTextInBubble 需要提供 options.imgWidth 和 options.imgHeight');
  }

  // 将归一化 bbox 转为像素坐标
  const x1 = bbox[0] * imgWidth;
  const y1 = bbox[1] * imgHeight;
  const x2 = bbox[2] * imgWidth;
  const y2 = bbox[3] * imgHeight;
  const boxWidth = x2 - x1;
  const boxHeight = y2 - y1;

  // 获取形状安全区域
  const safeArea = getSafeTextAreaForShape(shape, boxWidth, boxHeight);
  const usableW = safeArea.width;
  const usableH = safeArea.height;

  // ---------- 竖排文字处理 ----------
  if (direction === 'vertical') {
    const fontSize = fontSizeOverride || DEFAULT_FONT_SIZE;
    const { columns } = layoutVerticalText(text, usableH, fontSize);
    const charPositions = computeVerticalCharPositions(
      columns, usableW, usableH, fontSize, horizontalAlign, verticalAlign
    );

    const items = charPositions.map(p => ({
      text: p.char,
      x: x1 + safeArea.offsetX + p.x,
      y: y1 + safeArea.offsetY + p.y,
      fontSize: p.fontSize
    }));

    return { items, fontSize, linesCount: columns.length, isVertical: true };
  }

  // ---------- 水平文字处理 ----------
  let fontSize = fontSizeOverride;
  let lines = [];

  if (fontSizeOverride) {
    lines = wrapTextToLines(text, usableW, fontSizeOverride);
  } else {
    const fit = fitTextToBox(text, usableW, usableH, DEFAULT_FONT_SIZE, maxLines);
    fontSize = fit.fontSize;
    lines = fit.lines;
  }

  const { positions: xPositions, spacings } = computeHorizontalPositions(
    lines, usableW, fontSize, horizontalAlign
  );
  const startY = computeVerticalStartY(lines, usableH, fontSize, verticalAlign);

  const items = [];

  if (horizontalAlign === 'justify') {
    // 两端对齐：生成字符级别的详细坐标
    lines.forEach((line, idx) => {
      const lineY = y1 + safeArea.offsetY + startY + idx * getLineHeight(fontSize);
      const baseX = x1 + safeArea.offsetX + xPositions[idx];
      const extraGap = spacings[idx];
      const charPositions = generateJustifiedCharPositions(
        line, baseX, lineY, fontSize, extraGap
      );
      charPositions.forEach(p => {
        items.push({ text: p.char, x: p.x, y: p.y, fontSize });
      });
    });
  } else {
    lines.forEach((line, idx) => {
      items.push({
        text: line,
        x: x1 + safeArea.offsetX + xPositions[idx],
        y: y1 + safeArea.offsetY + startY + idx * getLineHeight(fontSize),
        fontSize
      });
    });
  }

  return { items, fontSize, linesCount: lines.length, isVertical: false };
}

// ===================== 批量排版 =====================

/**
 * 批量处理多个气泡的排版
 * @param {Array} bubbles - 每个元素包含 { text, bbox, direction?, shape?, ... }
 * @param {number} imgWidth - 图片宽度
 * @param {number} imgHeight - 图片高度
 * @returns {Array} 每个气泡的排版结果
 */
function layoutMultipleBubbles(bubbles, imgWidth, imgHeight) {
  return bubbles.map(bubble => {
    try {
      return layoutTextInBubble(bubble.text, bubble.bbox, {
        direction: bubble.direction || 'horizontal',
        shape: bubble.shape || 'rectangle',
        horizontalAlign: bubble.horizontalAlign || 'center',
        verticalAlign: bubble.verticalAlign || 'middle',
        fontSizeOverride: bubble.fontSize,
        maxLines: bubble.maxLines || MAX_LINES,
        imgWidth,
        imgHeight
      });
    } catch (err) {
      console.warn('气泡排版失败:', err);
      return { items: [], fontSize: DEFAULT_FONT_SIZE, linesCount: 0, isVertical: false };
    }
  });
}

// ===================== 预设样式集 =====================

const STYLE_PRESETS = {
  default: {
    horizontalAlign: 'center',
    verticalAlign: 'middle',
    maxLines: 4,
    shape: 'rectangle'
  },
  mangaClassic: {
    horizontalAlign: 'left',
    verticalAlign: 'middle',
    maxLines: 3,
    shape: 'rounded'
  },
  webtoon: {
    horizontalAlign: 'center',
    verticalAlign: 'middle',
    maxLines: 2,
    shape: 'rectangle'
  },
  verticalClassic: {
    direction: 'vertical',
    horizontalAlign: 'center',
    verticalAlign: 'middle',
    shape: 'rectangle'
  },
  elegantJustify: {
    horizontalAlign: 'justify',
    verticalAlign: 'middle',
    maxLines: 4,
    shape: 'ellipse'
  }
};

// ---------- 调试示例 ----------
/*
const testLayout = layoutTextInBubble(
  'こんにちは、世界！',
  [0.1, 0.05, 0.3, 0.2],
  {
    imgWidth: 800,
    imgHeight: 600,
    shape: 'rounded',
    horizontalAlign: 'justify'
  }
);
console.log(testLayout);
*/