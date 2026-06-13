# HTML PPT 模板说明

这个项目用单个 `模板.html` 制作 16:9 固定画布幻灯片，并提供本地演讲、控制端同步、观众端观看和 PPTX 导出能力。

## 使用方式

- 直接打开 `模板.html`：本地演讲者模式。可以翻页、全屏、查看演讲者注释，并使用纯前端 PPTX 导出。
- 启动 `server.js`：控制端和观众端同步翻页。控制端可以查看演讲者注释，并使用纯前端或服务端 PPTX 导出。
- 运行导出脚本：命令行生成 PPTX，脚本会临时启动本地服务并调用系统 Chrome Headless 渲染。

## 本地演讲者模式

直接双击或用浏览器打开 `模板.html` 即可进入本地演讲者模式。页面会显示底部演讲者注释抽屉，排版与服务控制端一致：幻灯片区域会为注释抽屉预留空间，而不是被注释遮挡。

本地文件模式不会读取外置 `speaker-notes.json`，因为浏览器通常会限制 `file://` 页面读取同目录 JSON。它读取 `模板.html` 内的 `<script id="speaker-notes-data" type="application/json">` 作为内嵌注释数据。

## 启动同步服务

```bash
CONTROL_TOKEN=your-secret PORT=3000 node server.js
```

控制端地址：

```text
http://localhost:3000/?role=control&token=your-secret
```

观众端地址：

```text
http://localhost:3000/?role=audience
```

观众端只显示演示画面、进度条和同步状态，不显示左侧目录、导出按钮、翻页按钮或演讲者注释。观众端不能本地翻页，但可以按 `f` 全屏。

控制端会通过 `CONTROL_TOKEN` 调用受保护接口：

- `POST /api/control`：同步当前页到观众端。
- `GET /api/speaker-notes`：读取外置 `speaker-notes.json`。
- `POST /api/export-pptx`：执行服务端 PPTX 导出。

`/speaker-notes.json` 不作为公开静态文件提供，避免观众直接读取备注。

## 演讲者注释

服务控制端读取同目录下的 `speaker-notes.json`。本地演讲者模式读取 `模板.html` 里的 `speaker-notes-data`。两份数据都使用 1-based 页码字符串作为键：

```json
{
  "1": "封面页演讲者注释",
  "2": "目录页演讲者注释"
}
```

维护幻灯片时，如果新增、删除或重排页面，请同步更新：

- `speaker-notes.json`
- `模板.html` 内的 `speaker-notes-data`
- 每页 `.page-num`
- 可见总页数和缩略图相关数据

缺失的页码会显示“本页暂无演讲者注释”。

## PPTX 导出

前端“导出PPTX”弹窗有四种模式：

| 模式 | 是否需要服务 | 输出 | 说明 |
|---|---:|---|---|
| 纯前端导出 | 否 | `presentation_exported_16x9.pptx` | 浏览器内用 `html2canvas` 截图并用 `pptxgen` 写入 PPTX。适合本地快速导出。 |
| 服务端普通 | 是 | `presentation_exported_script.pptx` | 服务端调用 Chrome Headless，将每页作为完整 4K 图片写入 PPTX。 |
| 服务端高级 | 是 | `presentation_components.pptx` | 服务端按组件框拆分背景、框层、文字层和图片组件，便于后期移动组件。 |
| 服务端可编辑文字 | 是 | `presentation_editable_text.pptx` | 服务端尽量把常规文字转成 PPT 原生文本框；复杂文字保留 PNG。 |

非控制端或本地文件模式下，只有“纯前端导出”可用。三种服务端导出需要从带 `token` 的控制端页面打开。

默认截图为 4K：固定 1280 x 720 HTML 画布乘以 `EXPORT_SCALE=3`，得到 3840 x 2160 输出。

## 命令行导出

普通整页导出：

```bash
node export-pptx.js
```

组件框导出：

```bash
COMPONENT_EXPORT_MODE=advanced node export-components.js
```

可编辑文字导出：

```bash
COMPONENT_EXPORT_MODE=editable node export-components.js
```

可选环境变量：

- `EXPORT_SCALE`：截图倍率，默认 `3`。
- `EXPORT_W` / `EXPORT_H`：渲染窗口尺寸，默认 `1280` / `720`。
- `COMPONENT_EXPORT_SCALE`：组件导出的截图倍率，默认继承 `EXPORT_SCALE`，否则为 `3`。
- `COMPONENT_EXPORT_W` / `COMPONENT_EXPORT_H`：组件导出窗口尺寸，默认继承 `EXPORT_W` / `EXPORT_H`。
- `CHROME_BIN`：自定义 Chrome/Chromium 可执行文件路径。
- `EXPORT_PORT` / `COMPONENT_EXPORT_PORT`：导出脚本临时服务端口。

导出脚本不安装依赖。它们会查找本机已有 Chrome 或 Chromium，并临时启动本项目的本地服务。

## 文件说明

- `模板.html`：幻灯片内容、样式、演讲者模式、同步客户端和前端导出逻辑。
- `speaker-notes.json`：服务控制端读取的演讲者注释。
- `server.js`：同步翻页、受保护注释接口和服务端导出接口。
- `export-pptx.js`：服务端普通整页 PPTX 导出。
- `export-components.js`：服务端高级组件框导出和可编辑文字导出。
- `lib/html2canvas.min.js`、`lib/pptxgen.bundle.js`：纯前端导出依赖，随项目提供。

## 维护清单

改动幻灯片后请检查：

- 页面总数、`.page-num`、目录和缩略图标题一致。
- `speaker-notes.json` 与 HTML 内嵌 `speaker-notes-data` 已同步。
- 本地打开 `模板.html` 时能看到演讲者注释。
- 控制端和观众端仍能分别打开。
- 导出弹窗仍显示四种模式，且非控制端只启用纯前端导出。
- 服务端普通、服务端高级和服务端可编辑文字导出仍能生成 PPTX。
