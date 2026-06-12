# HTML PPT 同步翻页部署说明

这个模板支持两种使用方式：

- 直接打开 `模板.html`：单机演示，保持原有翻页、全屏和 PPTX 导出功能。
- 通过 `server.js` 启动：控制端翻页，观众端自动同步翻页。

## 本地运行

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

## 部署

部署到支持 Node 的平台时，设置环境变量：

- `CONTROL_TOKEN`：控制端密钥，不要公开给观众。
- `PORT`：端口号，很多平台会自动提供。

观众只需要打开 `/?role=audience`。观众端只显示演示画面、进度条和同步状态，不显示左侧目录、导出按钮、翻页按钮或演讲者注释；观众端不能本地翻页，但可以按 `f` 全屏。控制端使用 `/?role=control&token=你的密钥`。

控制端的“导出PPTX”按钮会调用服务端导出接口生成并下载文件。部署机器需要安装 Chrome 或 Chromium；不需要安装 npm 包。

## 演讲者注释

控制端会通过密钥保护的接口加载同目录下的 `speaker-notes.json`，并在底部抽屉显示当前页注释。注释文件使用 1-based 页码作为键：

```json
{
  "1": "封面页演讲者注释",
  "2": "目录页演讲者注释"
}
```

缺失的页码会显示“本页暂无演讲者注释”。外置 JSON 注释需要通过 `node server.js` 访问；直接用 `file://` 打开 `模板.html` 时，浏览器可能阻止加载本地 JSON。为了避免观众直接查看备注，`/speaker-notes.json` 不作为公开静态文件提供。

## 脚本导出 PPTX

也可以使用无 npm 依赖的导出脚本生成 PPTX。脚本会启动本地服务，用系统 Chrome Headless 渲染每页截图，再写入 `presentation_exported_script.pptx`：

```bash
node export-pptx.js
```

可选环境变量：

- `EXPORT_SCALE`：截图倍率，默认 `2`。
- `EXPORT_W` / `EXPORT_H`：渲染窗口尺寸，默认 `1280` / `720`。
- `CHROME_BIN`：自定义 Chrome/Chromium 可执行文件路径。
