---
title: 支持的格式
---

# 支持的格式

Zeditor 以 Markdown 为核心，同时能直接打开多种文本格式，并把 Office 文档转换为 Markdown。

## 可直接编辑的格式

以下格式打开后直接进入编辑器：

- **Markdown**：`.md`、`.markdown`、`.mdx` 等常见扩展名
- **纯文本**：`.txt`
- **代码 / 结构化文本**：`.html`、`.json`、`.xml`、`.yaml` / `.yml`、`.csv` 等，以文本方式编辑

::: tip CSV 的双重身份
`.csv` 既可以作为纯文本直接编辑，也可以在资源管理器中触发转换为 Markdown 表格。
:::

## 可转换为 Markdown 的文档

以下格式通过内置的 [AnyDoc 转换模块](/guide/converter)转换为 Markdown，在新标签页中打开编辑：

| 类别 | 格式 | 说明 |
| --- | --- | --- |
| Microsoft Office | DOC、DOCX、DOCM | 保留标题、列表、表格等结构 |
| 演示文稿 | PPT、PPTX、PPTM、PPS 系列 | 保留幻灯片结构与演讲者备注 |
| 电子表格 | XLS、XLSX、XLSM、XLSB | 转换为 Markdown 表格 |
| OpenDocument | ODT、ODS、ODP | 文档、表格与演示文稿 |
| 其他文档 | RTF、EPUB、CSV、PDF | PDF 仅支持文本型文档 |

转换**始终在本机完成**，文件不会上传到任何服务器；转换模块首次使用时按需下载（约数 MB），也可离线导入。

## 不支持的范围

- **扫描型 PDF**（图片型）：需要 OCR 引擎，当前版本不支持
- **图片、音频、视频**：不作为文档打开；图片走[插入流程](/guide/images)，音视频走[媒体嵌入](/guide/media)
- **MSG、Notebook** 等专有格式：不在当前转换模块范围内

## Markdown 语法支持

编辑与预览以 GitHub 风格为基础，并做了扩展：

- **基础语法**：标题、列表、表格、引用、代码块、任务列表、分割线等全部支持
- **扩展语法**：KaTeX 公式、Mermaid 图表、Markmap 思维导图、SVG 围栏、图片尺寸 `{width=320}`、媒体指令 `@[video](…)`
- **换行行为**：预览采用「单换行即换行」的 GitHub 风格
- **注意**：脚注 `[^1]` 与高亮 `==…==` 可在编辑器中插入与编辑，但预览面板当前按普通文本显示

## 下一步

- [文档转换](/guide/converter) —— 转换模块的安装与使用
- [Mermaid 图表](/guide/mermaid) —— 在文档中画流程图与时序图
