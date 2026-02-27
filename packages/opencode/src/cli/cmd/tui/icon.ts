// @ts-ignore - RGBA type from @opentui/core
type RGBA = any

export type ToolIcon = {
  unicode: string
  nerd: string
  category: ToolCategory
}

export type ToolCategory =
  | "shell"
  | "file"
  | "search"
  | "task"
  | "web"
  | "interactive"
  | "unknown"

export const TOOL_ICONS: Record<string, ToolIcon> = {
  // Shell 操作
  bash: { unicode: "$", nerd: "\uf489", category: "shell" },

  // 文件操作
  read: { unicode: "→", nerd: "\uf15c", category: "file" },
  write: { unicode: "←", nerd: "\uf0c7", category: "file" },
  edit: { unicode: "✎", nerd: "\uf044", category: "file" },
  list: { unicode: "→", nerd: "\uf07b", category: "file" },
  apply_patch: { unicode: "🩹", nerd: "\uf440", category: "file" },

  // 搜索操作
  glob: { unicode: "✱", nerd: "\uf0b0", category: "search" },
  grep: { unicode: "🔍", nerd: "\uf002", category: "search" },
  codesearch: { unicode: "◇", nerd: "\uf121", category: "search" },
  websearch: { unicode: "◈", nerd: "\uf002", category: "search" },

  // 任务操作
  task: { unicode: "⚙", nerd: "\uf013", category: "task" },
  todowrite: { unicode: "☑", nerd: "\uf046", category: "task" },
  skill: { unicode: "🎯", nerd: "\uf05b", category: "task" },

  // Web 操作
  webfetch: { unicode: "🌐", nerd: "\uf0ac", category: "web" },

  // 交互操作
  question: { unicode: "?", nerd: "\uf128", category: "interactive" },

  // 默认
  generic: { unicode: "⚙", nerd: "\uf013", category: "unknown" },
}

export const CATEGORY_COLORS: Record<
  ToolCategory,
  { primary: keyof ThemeColors; secondary: keyof ThemeColors }
> = {
  shell: { primary: "success", secondary: "text" },
  file: { primary: "info", secondary: "warning" },
  search: { primary: "secondary", secondary: "textMuted" },
  task: { primary: "primary", secondary: "accent" },
  web: { primary: "info", secondary: "textMuted" },
  interactive: { primary: "accent", secondary: "text" },
  unknown: { primary: "text", secondary: "textMuted" },
}

export type ThemeColors = {
  primary: RGBA
  secondary: RGBA
  accent: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  info: RGBA
  text: RGBA
  textMuted: RGBA
  background: RGBA
  backgroundPanel: RGBA
  backgroundMenu: RGBA
  backgroundElement: RGBA
  border: RGBA
  borderActive: RGBA
  borderSubtle: RGBA
  diffAdded: RGBA
  diffRemoved: RGBA
  diffContext: RGBA
  diffHunkHeader: RGBA
  diffHighlightAdded: RGBA
  diffHighlightRemoved: RGBA
  diffAddedBg: RGBA
  diffRemovedBg: RGBA
  diffContextBg: RGBA
  diffLineNumber: RGBA
  diffAddedLineNumberBg: RGBA
  diffRemovedLineNumberBg: RGBA
  markdownText: RGBA
  markdownHeading: RGBA
  markdownLink: RGBA
  markdownLinkText: RGBA
  markdownCode: RGBA
  markdownBlockQuote: RGBA
  markdownEmph: RGBA
  markdownStrong: RGBA
  markdownHorizontalRule: RGBA
  markdownListItem: RGBA
  markdownListEnumeration: RGBA
  markdownImage: RGBA
  markdownImageText: RGBA
  markdownCodeBlock: RGBA
  syntaxComment: RGBA
  syntaxKeyword: RGBA
  syntaxFunction: RGBA
  syntaxVariable: RGBA
  syntaxString: RGBA
  syntaxNumber: RGBA
  syntaxType: RGBA
  syntaxOperator: RGBA
  syntaxPunctuation: RGBA
}

let nerdFontDetected: boolean | undefined

export function detectNerdFont(): boolean {
  if (nerdFontDetected !== undefined) {
    return nerdFontDetected
  }

  // 检测环境变量
  if (process.env.TERM_NERD_FONT === "1") {
    nerdFontDetected = true
    return true
  }

  // 检测常见支持 Nerd Font 的终端
  const termProgram = process.env.TERM_PROGRAM
  if (termProgram === "iTerm.app" || termProgram === "WezTerm" || termProgram === "Kitty") {
    nerdFontDetected = true
    return true
  }

  // 检测 kitty 终端
  if (process.env.KITTY_WINDOW_ID) {
    nerdFontDetected = true
    return true
  }

  // 默认不使用 Nerd Font
  nerdFontDetected = false
  return false
}

export function getToolIcon(tool: string): ToolIcon {
  return TOOL_ICONS[tool] || TOOL_ICONS.generic
}

export function getToolIconChar(tool: string): string {
  const icon = getToolIcon(tool)
  return detectNerdFont() ? icon.nerd : icon.unicode
}

export function getToolCategory(tool: string): ToolCategory {
  return getToolIcon(tool).category
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  const minutes = Math.floor(ms / 60000)
  const seconds = ((ms % 60000) / 1000).toFixed(0)
  return `${minutes}m${seconds}s`
}
