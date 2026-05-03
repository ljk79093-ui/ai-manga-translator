# AI Manga Translator

> AI 驱动的漫画图片翻译 Chrome 扩展，支持视觉模型、OCR + 翻译、精致机翻三种模式。

## 功能特色

- 🖼️ 图片翻译：支持视觉模型直接“看图说话”
- 🔍 OCR 翻译：Google Vision / 视觉模型提取文字后翻译
- ✨ 精致机翻：OCR + 重排序 + 翻译，确保语序自然
- 🎯 悬浮菜单：一键翻译、截屏翻译、参数调整
- 📱 多语言后处理：日语 / 韩语 / 英语拟声词优化、繁简转换
- 🗄️ 翻译缓存：支持 MySQL + FastAPI 后端缓存
- 🎨 气泡适配：自动换行、字号自适应、气泡轮廓检测
- 🛠 调试工具：控制台 `__mangaDebug` 对象

## 安装步骤

1. 下载本仓库 ZIP 或克隆到本地
2. 打开 Chrome，进入 `chrome://extensions`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择 `extension-folder` 目录
5. 打开任意漫画网站，点击悬浮按钮开始翻译

## 配置说明

- **API 密钥**：在选项页填写 OpenAI / Google Vision / DeepL / Azure 的密钥和端点
- **缓存后端**（可选）：复制 `.env.example` 为 `.env`，配置 MySQL 连接信息，运行 `python main.py`
- **调试模式**：选项页开启“调试模式”后，翻译将使用模拟数据，不消耗 API 额度

## 目录结构
extension-folder/
├── manifest.json
├── background.js
├── content.js
├── popup.html / popup.js
├── options.html / options.js
├── bubble-renderer.js
├── bubble-fit-engine.js
├── postprocess.js
├── crypto-utils.js
├── adapters/
│ ├── azure.js
│ └── deepl.js
├── _locales/
│ ├── zh_CN/messages.json
│ └── en/messages.json
├── backend/
│ ├── main.py
│ ├── requirements.txt
│ └── .env.example
└── README.md

## 声明

本项目代码由 DeepSeek 辅助生成，已通过人工审核和测试。

## 许可证

MIT License