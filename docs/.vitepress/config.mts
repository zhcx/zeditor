import { defineConfig } from 'vitepress'

const REPO = 'zhcx/zeditor'
const BASE = '/zeditor/'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Zeditor',
  description: '现代化的 Markdown 编辑器 —— 实时预览、AI 辅助写作、文档转换、多种导出与云备份',
  base: BASE,
  srcDir: '.',
  srcExclude: ['banner.png', '**/releases/**'],
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', type: 'image/png', href: `${BASE}logo.png` }],
    ['meta', { name: 'theme-color', content: '#1f2328' }]
  ],

  themeConfig: {
    logo: `${BASE}logo.png`,
    siteTitle: 'Zeditor',

    nav: [
      { text: '首页', link: '/' },
      { text: '指南', link: '/guide/', activeMatch: '/guide/' },
      { text: '参考', link: '/reference/shortcuts', activeMatch: '/reference/' },
      { text: '下载', link: `https://github.com/${REPO}/releases/latest` },
      {
        text: 'v0.5.9',
        items: [
          { text: '更新日志', link: `https://github.com/${REPO}/blob/main/CHANGELOG.md` },
          { text: '发布说明', link: `https://github.com/${REPO}/releases` }
        ]
      }
    ],

    sidebar: {
      '/guide/': [
        {
          text: '开始使用',
          items: [
            { text: '简介', link: '/guide/' },
            { text: '快速上手', link: '/guide/getting-started' },
            { text: '界面总览', link: '/guide/interface' },
            { text: '支持的格式', link: '/guide/formats' }
          ]
        },
        {
          text: '写作与编辑',
          items: [
            { text: '文件与工作区', link: '/guide/files' },
            { text: '编辑与格式', link: '/guide/editing' },
            { text: '斜杠命令', link: '/guide/slash-commands' },
            { text: '链接检查', link: '/guide/link-check' },
            { text: '图片', link: '/guide/images' },
            { text: '媒体：视频与音频', link: '/guide/media' }
          ]
        },
        {
          text: '渲染与图表',
          items: [
            { text: '数学公式', link: '/guide/math' },
            { text: 'Mermaid 图表', link: '/guide/mermaid' },
            { text: 'Markmap 思维导图', link: '/guide/markmap' },
            { text: '工作流查看器', link: '/guide/workflow-viewer' }
          ]
        },
        {
          text: '视图与输出',
          items: [
            { text: '视图模式与演示', link: '/guide/view-modes' },
            { text: '文档转换', link: '/guide/converter' },
            { text: '导出', link: '/guide/export' },
            { text: '云备份', link: '/guide/cloud-backup' }
          ]
        },
        {
          text: 'AI 与自动化',
          items: [
            { text: 'AI 助手', link: '/guide/ai/' },
            { text: 'AI 指令面板', link: '/guide/ai/instructions' },
            { text: '本地 Agent', link: '/guide/ai/agent' },
            { text: 'MCP 集成', link: '/guide/ai/mcp' }
          ]
        }
      ],
      '/reference/': [
        {
          text: '参考',
          items: [
            { text: '键盘快捷键', link: '/reference/shortcuts' },
            { text: '设置参考', link: '/reference/settings' },
            { text: '故障排除', link: '/reference/faq' }
          ]
        },
        {
          text: '深入阅读',
          items: [
            { text: 'MCP 集成完整指南', link: '/mcp-support' },
            { text: 'Agent 使用与安全说明', link: '/agent-support' },
            { text: '转换模块说明', link: '/converter-modules' },
            { text: '单页完整教程', link: '/usage-guide' }
          ]
        }
      ]
    },

    socialLinks: [{ icon: 'github', link: `https://github.com/${REPO}` }],

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '未找到相关结果',
            resetButtonTitle: '清除查询条件',
            displayDetails: '显示详细列表',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
          }
        }
      }
    },

    outline: { level: [2, 3], label: '本页目录' },

    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新于' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',

    footer: {
      message: '基于 MIT 许可证发布',
      copyright: 'Copyright © 2024–2026 zhcx'
    }
  }
})
