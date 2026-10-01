---
title: 媒体：视频与音频
---

# 媒体：视频与音频

Zeditor 通过行内指令语法在文档中嵌入视频与音频，支持本地文件与主流视频平台。

## 指令语法

写法为 `@[类型](地址)`，独占一行：

```markdown
@[video](.assets/demo.mp4)
@[audio](.assets/narration.mp3)
```

| 指令 | 作用 |
| --- | --- |
| `@[video](…)` | 本地或远程视频播放器 |
| `@[audio](…)` | 音频播放器 |
| `@[youtube](…)` | YouTube 播放器（隐私增强域名 youtube-nocookie） |
| `@[video](B 站链接)` | B 站播放器（支持 BV 号 / av 号链接） |
| `@[video](Vimeo 链接)` | Vimeo 播放器 |

### 平台链接示例

```markdown
@[video](https://www.bilibili.com/video/BVxxxxxxxx)
@[youtube](https://youtu.be/xxxxxxxxxxx)
@[video](https://vimeo.com/123456789)
```

::: tip B 站短链
`b23.tv` 短链因无法解析出 BV 号会保留原文，请使用完整视频页地址。
:::

## 可选属性

在指令后加大括号：

```markdown
@[video](.assets/demo.mp4){title="产品演示" poster=".assets/cover.jpg"}
```

- `title`：播放器下方的标题说明（不填显示文件名）
- `poster`：视频封面图（仅视频有效）

## 支持的文件格式

- **视频**：mp4、m4v、webm、ogv、mov、mkv、avi、wmv、flv
- **音频**：mp3、m4a、aac、wav、oga、ogg、opus、flac、weba

本地文件同样会复制到文档同级的 `.assets` 目录（见[图片的存储规则](/guide/images#assets-目录规则)，音视频素材适用同一规则），文件缺失时预览会显示提示。

## 便捷写法

用图片语法引用音视频文件时，会自动提升为播放器，无需记住指令：

```markdown
![](demo.mp4)
```

::: tip 插入入口
工具栏「插入 → 视频/音频」提供弹窗，可选择本地文件（复制到 `.assets`）或直接粘贴平台链接，不必手写语法。
:::

## 下一步

- [图片](/guide/images) —— 图片的插入、尺寸与图床
- [Mermaid 图表](/guide/mermaid) —— 在文档中绘制图表
