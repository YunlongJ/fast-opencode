import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  useContext,
  untrack,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import path from "path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { useTheme } from "@tui/context/theme"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  addDefaultParsers,
  MacOSScrollAccel,
  type ScrollAcceleration,
  TextAttributes,
  RGBA,
} from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type { AssistantMessage, Part, ToolPart, UserMessage, TextPart, ReasoningPart } from "@opencode-ai/sdk/v2"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import type { Tool } from "@/tool/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { BashTool } from "@/tool/bash"
import type { GlobTool } from "@/tool/glob"
import { TodoWriteTool } from "@/tool/todo"
import type { GrepTool } from "@/tool/grep"
import type { ListTool } from "@/tool/ls"
import type { EditTool } from "@/tool/edit"
import type { ApplyPatchTool } from "@/tool/apply_patch"
import type { WebFetchTool } from "@/tool/webfetch"
import type { TaskTool } from "@/tool/task"
import type { QuestionTool } from "@/tool/question"
import type { SkillTool } from "@/tool/skill"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "@tui/context/keybind"
import { Header } from "./header"
import { parsePatch } from "diff"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { Flag } from "@/flag/flag"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import parsers from "../../../../../../parsers-config.ts"
import { Clipboard } from "../../util/clipboard"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import { Editor } from "../../util/editor"
import stripAnsi from "strip-ansi"
import { Footer } from "./footer.tsx"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "@tui/context/exit"
import { Filesystem } from "@/util/filesystem"
import { Global } from "@/global"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscript } from "../../util/transcript"
import { UI } from "@/cli/ui.ts"
import { createStore, produce } from "solid-js/store"

addDefaultParsers(parsers.parsers)

class CustomSpeedScroll implements ScrollAcceleration {
  constructor(private speed: number) {}

  tick(_now?: number): number {
    return this.speed
  }

  reset(): void {}
}

// =============================================================================
// Types & Interfaces
// =============================================================================

interface SessionContextValue {
  width: number
  sessionID: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  diffWrapMode: () => "word" | "none"
  sync: ReturnType<typeof useSync>
}

interface MessageViewState {
  id: string
  role: "user" | "assistant"
  isReverted: boolean
  isRevertPoint: boolean
}

interface ScrollState {
  isAtBottom: boolean
  lastScrollY: number
}

const SessionContext = createContext<SessionContextValue>()

function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error("useSession must be used within a Session component")
  return ctx
}

// =============================================================================
// Session Component
// =============================================================================

export function Session() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  
  // ---------------------------------------------------------------------------
  // Core State - 使用 createMemo 优化计算
  // ---------------------------------------------------------------------------
  const session = createMemo(() => sync.session.get(route.sessionID))
  
  const sessionData = createMemo(() => {
    const s = session()
    if (!s) return null
    const parentID = s.parentID ?? s.id
    const children = sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return { ...s, children, parentID }
  })
  
  // 消息列表 - 使用 untrack 避免不必要的依赖追踪
  const messages = createMemo(() => {
    const msgs = sync.data.message[route.sessionID]
    if (!msgs) return []
    // 预计算消息视图状态，避免子组件重复计算
    return msgs.map((msg): MessageViewState => ({
      id: msg.id,
      role: msg.role as "user" | "assistant",
      isReverted: false,
      isRevertPoint: false,
    }))
  })
  
  // 使用 store 管理派生状态，避免重复计算
  const [derivedState, setDerivedState] = createStore({
    permissions: [] as any[],
    questions: [] as any[],
    pendingMessageId: undefined as string | undefined,
    lastAssistantId: undefined as string | undefined,
  })
  
  // 批量更新派生状态
  createEffect(() => {
    const s = sessionData()
    if (!s) return
    
    const msgs = sync.data.message[route.sessionID] ?? []
    const pendingId = msgs.findLast((x) => x.role === "assistant" && !x.time.completed)?.id
    const lastAssistantMsg = msgs.findLast((x) => x.role === "assistant")
    
    // 只在子会话中计算权限和问题
    const hasParent = !!s.parentID && s.parentID !== s.id
    const perms = hasParent ? [] : s.children.flatMap((x) => sync.data.permission[x.id] ?? [])
    const quests = hasParent ? [] : s.children.flatMap((x) => sync.data.question[x.id] ?? [])
    
    setDerivedState({
      permissions: perms,
      questions: quests,
      pendingMessageId: pendingId,
      lastAssistantId: lastAssistantMsg?.id,
    })
  })

  // ---------------------------------------------------------------------------
  // UI State
  // ---------------------------------------------------------------------------
  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "hide")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [animationsEnabled, setAnimationsEnabled] = kv.signal("animations_enabled", true)
  
  // 滚动状态管理
  const [scrollState, setScrollState] = createStore<ScrollState>({
    isAtBottom: true,
    lastScrollY: 0,
  })

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    const s = sessionData()
    if (!s) return false
    if (s.parentID && s.parentID !== s.id) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - (sidebarVisible() ? 42 : 0) - 4)

  const scrollAcceleration = createMemo(() => {
    const tui = sync.data.config.tui
    if (tui?.scroll_acceleration?.enabled) {
      return new MacOSScrollAccel()
    }
    if (tui?.scroll_speed) {
      return new CustomSpeedScroll(tui.scroll_speed)
    }
    return new CustomSpeedScroll(3)
  })

  createEffect(async () => {
    await sync.session
      .sync(route.sessionID)
      .then(() => {
        if (scroll) scroll.scrollBy(100_000)
      })
      .catch((e) => {
        console.error(e)
        toast.show({
          message: `Session not found: ${route.sessionID}`,
          variant: "error",
        })
        return navigate({ type: "home" })
      })
  })

  const toast = useToast()
  const sdk = useSDK()
  const local = useLocal()
  const dialog = useDialog()
  const renderer = useRenderer()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const exit = useExit()

  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------
  let scroll: ScrollBoxRenderable
  let prompt: PromptRef
  let lastSwitch: string | undefined = undefined

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------
  
  // Handle initial prompt from fork
  createEffect(() => {
    if (route.initialPrompt && prompt) {
      prompt.set(route.initialPrompt)
    }
  })

  // Agent mode switching based on tool events
  createEffect(() => {
    const handler = (evt: any) => {
      const part = evt.properties.part
      if (part.type !== "tool") return
      if (part.sessionID !== route.sessionID) return
      if (part.state.status !== "completed") return
      if (part.id === lastSwitch) return

      if (part.tool === "plan_exit") {
        local.agent.set("build")
        lastSwitch = part.id
      } else if (part.tool === "plan_enter") {
        local.agent.set("plan")
        lastSwitch = part.id
      }
    }
    sdk.event.on("message.part.updated", handler)
    onCleanup(() => sdk.event.off("message.part.updated", handler))
  })

  // Update exit message
  createEffect(() => {
    const s = sessionData()
    if (!s) return
    return exit.message.set(
      [
        ``,
        `  █▀▀█  ${UI.Style.TEXT_DIM}${s.title}${UI.Style.TEXT_NORMAL}`,
        `  █  █  ${UI.Style.TEXT_DIM}opencode -s ${s.id}${UI.Style.TEXT_NORMAL}`,
        `  ▀▀▀▀  `,
      ].join("\n"),
    )
  })

  // Keyboard handler for child session exit
  useKeyboard((evt) => {
    const s = sessionData()
    if (!s?.parentID || s.parentID === s.id) return
    if (keybind.match("app_exit", evt)) {
      exit()
    }
  })

  // ---------------------------------------------------------------------------
  // Scroll Helpers - 优化滚动性能
  // ---------------------------------------------------------------------------
  
  // 优化的滚动到底部函数 - 使用 requestAnimationFrame
  function scrollToBottom(immediate = false) {
    if (!scroll || scroll.isDestroyed) return
    
    if (immediate) {
      scroll.scrollTo(scroll.scrollHeight)
      return
    }
    
    // 使用 RAF 确保在下一帧执行，避免阻塞渲染
    requestAnimationFrame(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    })
  }

  // 优化的消息查找函数 - 缓存计算结果
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    if (!scroll) return null
    
    const children = scroll.getChildren()
    const scrollTop = scroll.y
    const msgs = untrack(() => sync.data.message[route.sessionID] ?? [])
    
    // 使用 Set 优化查找性能
    const validMessageIds = new Set(
      msgs
        .filter((m) => {
          const parts = sync.data.part[m.id]
          if (!parts || !Array.isArray(parts)) return false
          return parts.some((p) => p && p.type === "text" && !p.synthetic && !p.ignored)
        })
        .map((m) => m.id)
    )
    
    const visibleMessages = children
      .filter((c) => c.id && validMessageIds.has(c.id))
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    const offset = 10
    if (direction === "next") {
      return visibleMessages.find((c) => c.y > scrollTop + offset)?.id ?? null
    }
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - offset)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dlg: ReturnType<typeof useDialog>) => {
    if (!scroll) return
    
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dlg.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dlg.clear()
  }

  // ---------------------------------------------------------------------------
  // Navigation Helpers
  // ---------------------------------------------------------------------------
  
  function moveChild(direction: number) {
    const s = sessionData()
    if (!s) return
    if (s.children.length === 1) return
    
    let next = s.children.findIndex((x) => x.id === s.id) + direction
    if (next >= s.children.length) next = 0
    if (next < 0) next = s.children.length - 1
    
    if (s.children[next]) {
      navigate({
        type: "session",
        sessionID: s.children[next].id,
      })
    }
  }
  command.register(() => [
    {
      title: "Share session",
      value: "session.share",
      suggested: route.type === "session",
      keybind: "session_share",
      category: "Session",
      enabled: sync.data.config.share !== "disabled" && !session()?.share?.url,
      slash: {
        name: "share",
      },
      onSelect: async (dialog) => {
        await sdk.client.session
          .share({
            sessionID: route.sessionID,
          })
          .then((res) =>
            Clipboard.copy(res.data!.share!.url).catch(() =>
              toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }),
            ),
          )
          .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to share session", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Rename session",
      value: "session.rename",
      keybind: "session_rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      onSelect: (dialog) => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      keybind: "session_timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork from message",
      value: "session.fork",
      keybind: "session_fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      keybind: "session_compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      onSelect: (dialog) => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      keybind: "session_unshare",
      category: "Session",
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      onSelect: async (dialog) => {
        await sdk.client.session
          .unshare({
            sessionID: route.sessionID,
          })
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to unshare session", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      keybind: "messages_undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      onSelect: async (dlg) => {
        const status = sync.data.session_status?.[route.sessionID]
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const s = sessionData()
        const revert = s?.revert?.messageID
        const msgs = sync.data.message[route.sessionID] ?? []
        const message = msgs.findLast((x) => (!revert || x.id < revert) && x.role === "user")
        if (!message) return
        sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => scrollToBottom())
        const parts = sync.data.part[message.id]
        prompt.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dlg.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      keybind: "messages_redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      onSelect: (dlg) => {
        dlg.clear()
        const s = sessionData()
        const messageID = s?.revert?.messageID
        if (!messageID) return
        const msgs = sync.data.message[route.sessionID] ?? []
        const message = msgs.find((x) => x.role === "user" && x.id > messageID)
        if (!message) {
          sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt.set({ input: "", parts: [] })
          return
        }
        sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      keybind: "sidebar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      keybind: "messages_toggle_conceal" as any,
      category: "Session",
      onSelect: (dialog) => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      onSelect: (dialog) => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: showThinking() ? "Hide thinking" : "Show thinking",
      value: "session.toggle.thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      onSelect: (dialog) => {
        setShowThinking((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      keybind: "tool_details",
      category: "Session",
      onSelect: (dialog) => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      keybind: "scrollbar_toggle",
      category: "Session",
      onSelect: (dialog) => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      keybind: "messages_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      keybind: "messages_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      keybind: "messages_line_up",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      keybind: "messages_line_down",
      category: "Session",
      disabled: true,
      onSelect: (dialog) => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      keybind: "messages_half_page_up",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      keybind: "messages_half_page_down",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      keybind: "messages_first",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      keybind: "messages_last",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      keybind: "messages_last_user",
      category: "Session",
      hidden: true,
      onSelect: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      keybind: "messages_next",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      keybind: "messages_previous",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      keybind: "messages_copy",
      category: "Session",
      onSelect: (dialog) => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        Clipboard.copy(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
            },
          )
          await Clipboard.copy(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch (error) {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      keybind: "session_export",
      category: "Session",
      slash: {
        name: "export",
      },
      onSelect: async (dialog) => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Bun.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Bun.write(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch (error) {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Next child session",
      value: "session.child.next",
      keybind: "session_child_cycle",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        moveChild(1)
        dialog.clear()
      },
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      keybind: "session_child_cycle_reverse",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        moveChild(-1)
        dialog.clear()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      keybind: "session_parent",
      category: "Session",
      hidden: true,
      onSelect: (dialog) => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      },
    },
  ])

  // ---------------------------------------------------------------------------
  // Revert State - 使用 store 优化
  // ---------------------------------------------------------------------------
  const [revertState, setRevertState] = createStore({
    info: null as any,
    messageID: undefined as string | undefined,
    revertedMessages: [] as any[],
    diffFiles: [] as any[],
  })
  
  createEffect(() => {
    const s = sessionData()
    const info = s?.revert
    const messageID = info?.messageID
    const msgs = sync.data.message[route.sessionID] ?? []
    const reverted = messageID ? msgs.filter((x) => x.id >= messageID && x.role === "user") : []
    
    // Parse diff files
    let diffFiles: any[] = []
    const diffText = info?.diff ?? ""
    if (diffText) {
      try {
        const patches = parsePatch(diffText)
        diffFiles = patches.map((patch) => {
          const filename = patch.newFileName || patch.oldFileName || "unknown"
          const cleanFilename = filename.replace(/^[ab]\//, "")
          return {
            filename: cleanFilename,
            additions: patch.hunks.reduce(
              (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("+")).length,
              0,
            ),
            deletions: patch.hunks.reduce(
              (sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith("-")).length,
              0,
            ),
          }
        })
      } catch {}
    }
    
    setRevertState({
      info,
      messageID,
      revertedMessages: reverted,
      diffFiles,
    })
  })

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const ctxValue: SessionContextValue = {
    get width() { return contentWidth() },
    sessionID: route.sessionID,
    conceal,
    showThinking,
    showTimestamps,
    showDetails,
    diffWrapMode,
    sync,
  }

  return (
    <SessionContext.Provider value={ctxValue}>
      <box flexDirection="row">
        <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
          <Show when={sessionData()}>
            <Show when={!sidebarVisible() || !wide()}>
              <Header />
            </Show>
            <scrollbox
              ref={(r) => (scroll = r)}
              viewportOptions={{
                paddingRight: showScrollbar() ? 1 : 0,
              }}
              verticalScrollbarOptions={{
                paddingLeft: 1,
                visible: showScrollbar(),
                trackOptions: {
                  backgroundColor: theme.backgroundElement,
                  foregroundColor: theme.border,
                },
              }}
              stickyScroll={true}
              stickyStart="bottom"
              flexGrow={1}
              scrollAcceleration={scrollAcceleration()}
              onScroll={(y) => {
                // Track scroll position for smart scroll behavior
                const isAtBottom = y >= scroll.scrollHeight - scroll.height - 10
                setScrollState({ isAtBottom, lastScrollY: y })
              }}
            >
              <MessageList
                messages={messages()}
                revertState={revertState}
                pendingId={derivedState.pendingMessageId}
                lastAssistantId={derivedState.lastAssistantId}
                onMessageClick={(message) => {
                  if (renderer.getSelection()?.getSelectedText()) return
                  dialog.replace(() => (
                    <DialogMessage
                      messageID={message.id}
                      sessionID={route.sessionID}
                      setPrompt={(promptInfo) => prompt.set(promptInfo)}
                    />
                  ))
                }}
              />
            </scrollbox>
            <box flexShrink={0}>
              <Show when={derivedState.permissions.length > 0}>
                <PermissionPrompt request={derivedState.permissions[0]} />
              </Show>
              <Show when={derivedState.questions.length > 0}>
                <QuestionPrompt request={derivedState.questions[0]} />
              </Show>
              <Prompt
                visible={derivedState.permissions.length === 0 && derivedState.questions.length === 0}
                ref={(r) => {
                  if (!r) return
                  prompt = r
                  promptRef.set(r)
                  // Apply initial prompt when prompt component mounts (e.g., from fork)
                  if (route.initialPrompt) {
                    r.set(route.initialPrompt)
                  }
                }}
                disabled={derivedState.permissions.length > 0 || derivedState.questions.length > 0}
                onSubmit={() => scrollToBottom()}
                sessionID={route.sessionID}
              />
            </box>
          </Show>
          <Toast />
        </box>
        <Show when={sidebarVisible()}>
          <Switch>
            <Match when={wide()}>
              <Sidebar sessionID={route.sessionID} />
            </Match>
            <Match when={!wide()}>
              <box
                position="absolute"
                top={0}
                left={0}
                right={0}
                bottom={0}
                alignItems="flex-end"
                backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
              >
                <Sidebar sessionID={route.sessionID} />
              </box>
            </Match>
          </Switch>
        </Show>
      </box>
    </SessionContext.Provider>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = useSession()
  const local = useLocal()
  const text = createMemo(() => props.parts.flatMap((x) => (x.type === "text" && !x.synthetic ? [x] : []))[0])
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const sync = useSync()
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const [pressed, setPressed] = createSignal(false)
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => (queued() ? theme.accent : local.agent.color(props.message.agent)))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())
  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  // 计算背景色 - 添加微妙的渐变效果
  const backgroundColor = createMemo(() => {
    if (pressed()) return theme.backgroundMenu
    if (hover()) return theme.backgroundElement
    return theme.backgroundPanel
  })

  // 计算边框样式
  const borderStyle = createMemo(() => {
    if (queued()) return { char: "┃", color: theme.accent }
    return { char: "┃", color: color() }
  })

  return (
    <>
      <Show when={text()}>
        <box
          id={props.message.id}
          marginTop={props.index === 0 ? 0 : 1}
          flexShrink={0}
        >
          {/* 左侧装饰条 - 更现代的视觉效果 */}
          <box flexDirection="row">
            <box
              width={1}
              backgroundColor={borderStyle().color}
              style={{ fg: borderStyle().color }}
            >
              <text>{borderStyle().char}</text>
            </box>
            <box
              flexGrow={1}
              onMouseOver={() => setHover(true)}
              onMouseOut={() => {
                setHover(false)
                setPressed(false)
              }}
              onMouseDown={() => setPressed(true)}
              onMouseUp={() => {
                setPressed(false)
                props.onMouseUp()
              }}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={1}
              backgroundColor={backgroundColor()}
              flexShrink={0}
            >
              {/* 用户标识 */}
              <box flexDirection="row" gap={1} marginBottom={files().length ? 1 : 0}>
                <text style={{ fg: color(), bold: true }}>
                  {queued() ? "◉" : "▸"}
                </text>
                <text style={{ fg: theme.textMuted, bold: true }}>
                  You
                </text>
                <Show when={queued()}>
                  <text style={{ fg: theme.accent }}>
                    <span style={{ bg: theme.accent, fg: theme.background, bold: true }}> QUEUED </span>
                  </text>
                </Show>
              </box>

              {/* 消息内容 */}
              <text fg={theme.text} style={{ bold: false }}>
                {text()?.text}
              </text>

              {/* 文件附件 */}
              <Show when={files().length}>
                <box 
                  flexDirection="row" 
                  paddingTop={1} 
                  paddingBottom={metadataVisible() ? 1 : 0} 
                  gap={1} 
                  flexWrap="wrap"
                >
                  <For each={files()}>
                    {(file) => {
                      const fileStyle = createMemo(() => {
                        if (file.mime.startsWith("image/")) return { bg: theme.accent, icon: "🖼" }
                        if (file.mime === "application/pdf") return { bg: theme.primary, icon: "📄" }
                        if (file.mime === "application/x-directory") return { bg: theme.secondary, icon: "📁" }
                        return { bg: theme.secondary, icon: "📎" }
                      })
                      return (
                        <box 
                          flexDirection="row" 
                          gap={0}
                          style={{
                            bg: theme.backgroundElement,
                          }}
                        >
                          <text style={{ bg: fileStyle().bg, fg: theme.background, bold: true }}>
                            {" "}{fileStyle().icon}{" "}
                          </text>
                          <text style={{ bg: theme.backgroundElement, fg: theme.textMuted }}>
                            {" "}{file.filename}{" "}
                          </text>
                        </box>
                      )
                    }}
                  </For>
                </box>
              </Show>

              {/* 时间戳 */}
              <Show when={ctx.showTimestamps() && !queued()}>
                <text fg={theme.textMuted} marginTop={1}>
                  {Locale.todayTimeOrDateTime(props.message.time.created)}
                </text>
              </Show>
            </box>
          </box>
        </box>
      </Show>
      
      {/* Compaction 分隔线 */}
      <Show when={compaction()}>
        <box
          marginTop={1}
          marginBottom={1}
          flexDirection="row"
          alignItems="center"
          gap={1}
        >
          <box flexGrow={1} height={1} backgroundColor={theme.borderSubtle} />
          <text fg={theme.textMuted} style={{ italic: true }}>
            {" "}Compaction{" "}
          </text>
          <box flexGrow={1} height={1} backgroundColor={theme.borderSubtle} />
        </box>
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  const [hover, setHover] = createSignal(false)

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })

  const duration = createMemo(() => {
    if (!final()) return 0
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
  })

  const agentColor = createMemo(() => local.agent.color(props.message.agent))
  const isError = createMemo(() => props.message.error?.name === "MessageAbortedError")
  const hasError = createMemo(() => props.message.error && !isError())
  
  // 只有当是最后一条消息且消息未完成时才显示 spinner
  const isProcessing = createMemo(() => {
    return props.last && !final() && !isError()
  })

  return (
    <>
      {/* 助手消息头部标识 */}
      <box 
        flexDirection="row" 
        gap={1} 
        paddingLeft={3} 
        marginTop={1}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        <text style={{ fg: agentColor(), bold: true }}>
          {hasError() ? "✕" : isError() ? "⏹" : final() ? "●" : "◆"}
        </text>
        <text style={{ fg: theme.textMuted, bold: true }}>
          {Locale.titlecase(props.message.agent)}
        </text>
        <Show when={isProcessing()}>
          <Spinner color={agentColor()} />
        </Show>
      </box>

      {/* 消息内容 */}
      <For each={props.parts}>
        {(part, index) => {
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          return (
            <Show when={component()}>
              <Dynamic
                last={index() === props.parts.length - 1}
                component={component()}
                part={part as any}
                message={props.message}
              />
            </Show>
          )
        }}
      </For>

      {/* 错误提示 - 更醒目的设计 */}
      <Show when={hasError()}>
        <box
          marginTop={1}
          marginLeft={3}
          flexShrink={0}
        >
          <box flexDirection="row">
            <box
              width={1}
              backgroundColor={theme.error}
            >
              <text style={{ fg: theme.error }}>┃</text>
            </box>
            <box
              flexGrow={1}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              backgroundColor={theme.backgroundPanel}
            >
              <box flexDirection="row" gap={1} marginBottom={1}>
                <text style={{ fg: theme.error, bold: true }}>✕ Error</text>
              </box>
              <text fg={theme.textMuted}>{props.message.error?.data.message}</text>
            </box>
          </box>
        </box>
      </Show>

      {/* 消息元数据 */}
      <Switch>
        <Match when={props.last || final() || isError()}>
          <box 
            paddingLeft={3} 
            marginTop={1}
            marginBottom={1}
          >
            <box flexDirection="row" gap={1} alignItems="center">
              <text style={{ fg: isError() ? theme.textMuted : agentColor() }}>
                {isError() ? "⏹" : "●"}
              </text>
              <text style={{ fg: theme.text }}>
                {Locale.titlecase(props.message.mode)}
              </text>
              <text style={{ fg: theme.textMuted }}>
                · {props.message.modelID}
              </text>
              <Show when={duration()}>
                <text style={{ fg: theme.textMuted }}>
                  · {Locale.duration(duration())}
                </text>
              </Show>
              <Show when={isError()}>
                <text style={{ fg: theme.warning }}>
                  · interrupted
                </text>
              </Show>
            </box>
          </box>
        </Match>
      </Switch>
    </>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
  reasoning: ReasoningPart,
}

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme, subtleSyntax } = useTheme()
  const ctx = useSession()
  const [expanded, setExpanded] = createSignal(true)
  
  const content = createMemo(() => {
    // Filter out redacted reasoning chunks from OpenRouter
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  
  const lines = createMemo(() => content().split("\n").length)
  const shouldCollapse = createMemo(() => lines() > 5)
  
  const displayContent = createMemo(() => {
    if (!shouldCollapse() || expanded()) return content()
    return content().split("\n").slice(0, 5).join("\n") + "\n..."
  })

  return (
    <Show when={content() && ctx.showThinking()}>
      <box
        id={"text-" + props.part.id}
        marginTop={1}
        marginLeft={3}
        flexDirection="column"
        flexShrink={0}
      >
        <box flexDirection="row">
          {/* 左侧装饰条 */}
          <box
            width={1}
            backgroundColor={theme.backgroundElement}
          >
            <text style={{ fg: theme.backgroundElement }}>┃</text>
          </box>
          
          <box
            flexGrow={1}
            paddingLeft={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={theme.backgroundPanel}
          >
            {/* 头部 */}
            <box 
              flexDirection="row" 
              gap={1} 
              marginBottom={1}
              onMouseUp={() => shouldCollapse() && setExpanded(!expanded())}
            >
              <text style={{ fg: theme.textMuted, italic: true }}>
                💭 Thinking
              </text>
              <Show when={shouldCollapse()}>
                <text style={{ fg: theme.textMuted }}>
                  {expanded() ? "〔收起〕" : "〔展开〕"}
                </text>
              </Show>
            </box>
            
            {/* 内容 */}
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={subtleSyntax()}
              content={displayContent()}
              conceal={ctx.conceal()}
              fg={theme.textMuted}
            />
          </box>
        </box>
      </box>
    </Show>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = useSession()
  const { theme, syntax } = useTheme()
  const [hover, setHover] = createSignal(false)
  
  const content = createMemo(() => props.part.text.trim())
  const isStreaming = createMemo(() => !props.message.time.completed)

  return (
    <Show when={content()}>
      <box 
        id={"text-" + props.part.id} 
        paddingLeft={3} 
        marginTop={1} 
        flexShrink={0}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        <box flexDirection="row">
          <box flexGrow={1}>
            <Switch>
              <Match when={Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
                <markdown
                  syntaxStyle={syntax()}
                  streaming={isStreaming()}
                  content={content()}
                  conceal={ctx.conceal()}
                />
              </Match>
              <Match when={!Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
                <code
                  filetype="markdown"
                  drawUnstyledText={false}
                  streaming={isStreaming()}
                  syntaxStyle={syntax()}
                  content={content()}
                  conceal={ctx.conceal()}
                  fg={theme.text}
                />
              </Match>
            </Switch>
          </box>
          
          {/* 流式指示器 */}
          <Show when={isStreaming() && props.last}>
            <box paddingLeft={1}>
              <text style={{ fg: theme.accent }}>▌</text>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = useSession()
  const sync = useSync()

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={props.part.tool === "bash"}>
          <Bash {...toolprops} />
        </Match>
        <Match when={props.part.tool === "glob"}>
          <Glob {...toolprops} />
        </Match>
        <Match when={props.part.tool === "read"}>
          <Read {...toolprops} />
        </Match>
        <Match when={props.part.tool === "grep"}>
          <Grep {...toolprops} />
        </Match>
        <Match when={props.part.tool === "list"}>
          <List {...toolprops} />
        </Match>
        <Match when={props.part.tool === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "codesearch"}>
          <CodeSearch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "websearch"}>
          <WebSearch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "write"}>
          <Write {...toolprops} />
        </Match>
        <Match when={props.part.tool === "edit"}>
          <Edit {...toolprops} />
        </Match>
        <Match when={props.part.tool === "task"}>
          <Task {...toolprops} />
        </Match>
        <Match when={props.part.tool === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={props.part.tool === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={props.part.tool === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps<T extends Tool.Info> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolPart
}
function GenericTool(props: ToolProps<any>) {
  return (
    <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
      {props.tool} {input(props.input)}
    </InlineTool>
  )
}

function ToolTitle(props: { fallback: string; when: any; icon: string; children: JSX.Element }) {
  const { theme } = useTheme()
  return (
    <text paddingLeft={3} fg={props.when ? theme.textMuted : theme.text}>
      <Show fallback={<>~ {props.fallback}</>} when={props.when}>
        <span style={{ bold: true }}>{props.icon}</span> {props.children}
      </Show>
    </text>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  children: JSX.Element
  part: ToolPart
}) {
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const ctx = useSession()
  const sync = useSync()
  const [hover, setHover] = createSignal(false)

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const status = createMemo(() => props.part.state.status)
  
  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (props.complete) return theme.textMuted
    return theme.text
  })

  const iconColor = createMemo(() => {
    if (props.iconColor) return props.iconColor
    if (status() === "error") return theme.error
    if (status() === "completed") return theme.success
    if (status() === "running") return theme.accent
    return theme.textMuted
  })

  const error = createMemo(() => (status() === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  return (
    <box
      marginTop={margin()}
      paddingLeft={3}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) return
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <box 
        flexDirection="row" 
        gap={1}
        paddingLeft={3}
        style={{
          fg: fg(),
          attributes: denied() ? TextAttributes.STRIKETHROUGH : undefined,
        }}
      >
        <Show 
          fallback={
            <text style={{ fg: theme.textMuted }}>
              ~ {props.pending}
            </text>
          } 
          when={props.complete}
        >
          <text style={{ fg: iconColor(), bold: status() === "running" }}>
            {status() === "running" ? "◐" : props.icon}
          </text>
          <text>{props.children}</text>
        </Show>
      </box>
      
      <Show when={error() && !denied()}>
        <box flexDirection="row" gap={1} paddingLeft={6} marginTop={1}>
          <text style={{ fg: theme.error }}>✕</text>
          <text style={{ fg: theme.error }}>{error()}</text>
        </box>
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title: string
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
  icon?: string
  variant?: "default" | "success" | "warning" | "error"
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const [pressed, setPressed] = createSignal(false)
  
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  const status = createMemo(() => props.part?.state.status)
  
  // 根据状态确定颜色
  const statusColor = createMemo(() => {
    if (props.variant === "error" || error()) return theme.error
    if (props.variant === "success" || status() === "completed") return theme.success
    if (props.variant === "warning") return theme.warning
    if (status() === "running") return theme.accent
    return theme.border
  })

  const icon = createMemo(() => {
    if (props.icon) return props.icon
    if (error()) return "✕"
    if (status() === "completed") return "✓"
    if (status() === "running") return "◐"
    return "◆"
  })

  const backgroundColor = createMemo(() => {
    if (pressed()) return theme.backgroundMenu
    if (hover()) return theme.backgroundElement
    return theme.backgroundPanel
  })

  return (
    <box
      marginTop={1}
      flexShrink={0}
    >
      <box flexDirection="row">
        {/* 左侧状态条 */}
        <box
          width={1}
          backgroundColor={statusColor()}
        >
          <text style={{ fg: statusColor() }}>┃</text>
        </box>
        
        {/* 内容区域 */}
        <box
          flexGrow={1}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={1}
          gap={1}
          backgroundColor={backgroundColor()}
          onMouseOver={() => props.onClick && setHover(true)}
          onMouseOut={() => {
            setHover(false)
            setPressed(false)
          }}
          onMouseDown={() => props.onClick && setPressed(true)}
          onMouseUp={() => {
            setPressed(false)
            if (renderer.getSelection()?.getSelectedText()) return
            props.onClick?.()
          }}
        >
          {/* 标题栏 */}
          <box flexDirection="row" gap={1} alignItems="center">
            <text style={{ fg: statusColor(), bold: true }}>
              {icon()}
            </text>
            <Show
              when={props.spinner}
              fallback={
                <text style={{ fg: theme.textMuted, bold: true }}>
                  {props.title.replace(/^# /, "")}
                </text>
              }
            >
              <Spinner color={theme.accent}>{props.title.replace(/^# /, "")}</Spinner>
            </Show>
            <Show when={props.onClick}>
              <text style={{ fg: theme.textMuted }}>
                {hover() ? "〔点击展开〕" : ""}
              </text>
            </Show>
          </box>
          
          {/* 内容 */}
          {props.children}
          
          {/* 错误信息 */}
          <Show when={error()}>
            <box 
              flexDirection="row" 
              gap={1} 
              marginTop={1}
              paddingTop={1}
              style={{ borderTop: true, borderColor: theme.borderSubtle }}
            >
              <text style={{ fg: theme.error, bold: true }}>✕</text>
              <text style={{ fg: theme.error }}>{error()}</text>
            </box>
          </Show>
        </box>
      </box>
    </box>
  )
}

function Bash(props: ToolProps<typeof BashTool>) {
  const { theme } = useTheme()
  const sync = useSync()
  const output = createMemo(() => stripAnsi(props.metadata.output?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const overflow = createMemo(() => lines().length > 10)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, 10), "…"].join("\n")
  })

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined

    const base = sync.data.path.directory
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Global.Path.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })

  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <text fg={theme.text}>$ {props.input.command}</text>
            <Show when={output()}>
              <text fg={theme.text}>{limited()}</text>
            </Show>
            <Show when={overflow()}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Write(props: ToolProps<typeof WriteTool>) {
  const { theme, syntax } = useTheme()
  const code = createMemo(() => {
    if (!props.input.content) return ""
    return props.input.content
  })

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    return props.metadata.diagnostics?.[filePath] ?? []
  })

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool title={"# Wrote " + normalizePath(props.input.filePath!)} part={props.part}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(props.input.filePath!)}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Show when={diagnostics().length}>
            <For each={diagnostics()}>
              {(diagnostic) => (
                <text fg={theme.error}>
                  Error [{diagnostic.range.start.line}:{diagnostic.range.start.character}]: {diagnostic.message}
                </text>
              )}
            </For>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write..." complete={props.input.filePath} part={props.part}>
          Write {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={props.input.pattern} part={props.part}>
      Glob "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.count}>
        ({props.metadata.count} {props.metadata.count === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps<typeof ReadTool>) {
  const { theme } = useTheme()
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool icon="→" pending="Reading file..." complete={props.input.filePath} part={props.part}>
        Read {normalizePath(props.input.filePath!)} {input(props.input, ["filePath"])}
        <Show when={props.metadata.sizeHuman}>
          {" "}
          ({props.metadata.sizeHuman})
        </Show>
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {normalizePath(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps<typeof GrepTool>) {
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={props.input.pattern} part={props.part}>
      Grep "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.matches}>
        ({props.metadata.matches} {props.metadata.matches === 1 ? "match" : "matches"})
      </Show>
    </InlineTool>
  )
}

function List(props: ToolProps<typeof ListTool>) {
  const dir = createMemo(() => {
    if (props.input.path) {
      return normalizePath(props.input.path)
    }
    return ""
  })
  return (
    <InlineTool icon="→" pending="Listing directory..." complete={props.input.path !== undefined} part={props.part}>
      List {dir()}
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={(props.input as any).url} part={props.part}>
      WebFetch {(props.input as any).url}
    </InlineTool>
  )
}

function CodeSearch(props: ToolProps<any>) {
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◇" pending="Searching code..." complete={input.query} part={props.part}>
      Exa Code Search "{input.query}" <Show when={metadata.results}>({metadata.results} results)</Show>
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<any>) {
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={input.query} part={props.part}>
      Exa Web Search "{input.query}" <Show when={metadata.numResults}>({metadata.numResults} results)</Show>
    </InlineTool>
  )
}

function Task(props: ToolProps<typeof TaskTool>) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const { navigate } = useRoute()
  const local = useLocal()
  const sync = useSync()

  const tools = createMemo(() => {
    const sessionID = props.metadata.sessionId
    const msgs = sync.data.message[sessionID ?? ""] ?? []
    return msgs.flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const executedTools = createMemo(() => tools().filter((x) => x.state.status !== "pending"))
  const current = createMemo(() => executedTools().findLast((x) => x.state.status !== "pending"))

  const isRunning = createMemo(() => props.part.state.status === "running")

  return (
    <Switch>
      <Match
        when={(props.input.description || props.input.subagent_type) && (executedTools().length > 0 || isRunning())}
      >
        <BlockTool
          title={"# " + Locale.titlecase(props.input.subagent_type ?? "unknown") + " Task"}
          onClick={
            props.metadata.sessionId
              ? () => navigate({ type: "session", sessionID: props.metadata.sessionId! })
              : undefined
          }
          part={props.part}
          spinner={isRunning()}
        >
          <box>
            <text style={{ fg: theme.textMuted }}>
              {props.input.description} ({executedTools().length} toolcalls)
            </text>
            <Show when={current()}>
              {(item) => {
                const title = item().state.status === "completed" ? (item().state as any).title : ""
                return (
                  <text style={{ fg: item().state.status === "error" ? theme.error : theme.textMuted }}>
                    └ {Locale.titlecase(item().tool)} {title}
                  </text>
                )
              }}
            </Show>
          </box>
          <Show when={props.metadata.sessionId}>
            <text fg={theme.text}>
              {keybind.print("session_child_cycle")}
              <span style={{ fg: theme.textMuted }}> view subagents</span>
            </text>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="#" pending="Delegating..." complete={props.input.subagent_type} part={props.part}>
          {props.input.subagent_type} Task {props.input.description}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Edit(props: ToolProps<typeof EditTool>) {
  const ctx = useSession()
  const { theme, syntax } = useTheme()

  const view = createMemo(() => {
    const diffStyle = ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(props.input.filePath))

  const diffContent = createMemo(() => props.metadata.diff)

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    const arr = props.metadata.diagnostics?.[filePath] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
  })

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool title={"← Edit " + normalizePath(props.input.filePath!)} part={props.part}>
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
              fg={theme.text}
              addedBg={theme.diffAddedBg}
              removedBg={theme.diffRemovedBg}
              contextBg={theme.diffContextBg}
              addedSignColor={theme.diffHighlightAdded}
              removedSignColor={theme.diffHighlightRemoved}
              lineNumberFg={theme.diffLineNumber}
              lineNumberBg={theme.diffContextBg}
              addedLineNumberBg={theme.diffAddedLineNumberBg}
              removedLineNumberBg={theme.diffRemovedLineNumberBg}
            />
          </box>
          <Show when={diagnostics().length}>
            <box>
              <For each={diagnostics()}>
                {(diagnostic) => (
                  <text fg={theme.error}>
                    Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]{" "}
                    {diagnostic.message}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={props.input.filePath} part={props.part}>
          Edit {normalizePath(props.input.filePath!)} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps<typeof ApplyPatchTool>) {
  const ctx = useSession()
  const { theme, syntax } = useTheme()

  const files = createMemo(() => props.metadata.files ?? [])

  const view = createMemo(() => {
    const diffStyle = ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <diff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={ctx.diffWrapMode()}
          fg={theme.text}
          addedBg={theme.diffAddedBg}
          removedBg={theme.diffRemovedBg}
          contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded}
          removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber}
          lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg}
          removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
      </box>
    )
  }

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + normalizePath(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <Diff diff={file.diff} filePath={file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing apply_patch..." complete={false} part={props.part}>
          apply_patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps<typeof TodoWriteTool>) {
  const { theme } = useTheme()
  
  const completedCount = createMemo(() => 
    (props.input.todos ?? []).filter((t) => t.status === "completed").length
  )
  const totalCount = createMemo(() => props.input.todos?.length ?? 0)
  const progress = createMemo(() => 
    totalCount() > 0 ? Math.round((completedCount() / totalCount()) * 100) : 0
  )

  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool 
          title={`Todos (${completedCount()}/${totalCount()})`} 
          part={props.part}
          icon="☐"
          variant={completedCount() === totalCount() ? "success" : "default"}
        >
          <box gap={1}>
            {/* 进度条 */}
            <Show when={totalCount() > 1}>
              <box flexDirection="row" gap={1} alignItems="center">
                <box 
                  flexGrow={1} 
                  height={1} 
                  backgroundColor={theme.backgroundElement}
                >
                  <box 
                    width={`${progress()}%`}
                    height={1}
                    backgroundColor={progress() === 100 ? theme.success : theme.accent}
                  />
                </box>
                <text style={{ fg: theme.textMuted, bold: true }}>
                  {progress()}%
                </text>
              </box>
            </Show>
            
            {/* Todo 列表 */}
            <box gap={0}>
              <For each={props.input.todos ?? []}>
                {(todo, index) => (
                  <TodoItem 
                    status={todo.status} 
                    content={todo.content}
                    index={index() + 1}
                  />
                )}
              </For>
            </box>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="☐" pending="Updating todos..." complete={false} part={props.part}>
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<typeof QuestionTool>) {
  const { theme } = useTheme()
  const count = createMemo(() => props.input.questions?.length ?? 0)

  function format(answer?: string[]) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps<typeof SkillTool>) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={props.input.name} part={props.part}>
      Skill "{props.input.name}"
    </InlineTool>
  )
}

function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) {
    return path.relative(process.cwd(), input) || "."
  }
  return input
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

// =============================================================================
// MessageList Component - 优化消息列表渲染
// =============================================================================

interface MessageListProps {
  messages: MessageViewState[]
  revertState: {
    messageID?: string
    revertedMessages: any[]
    diffFiles: any[]
  }
  pendingId?: string
  lastAssistantId?: string
  onMessageClick: (message: any) => void
}

function MessageList(props: MessageListProps) {
  const ctx = useSession()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const dialog = useDialog()
  const sync = useSync()

  return (
    <For each={props.messages}>
      {(message, index) => {
        const isRevertPoint = message.id === props.revertState.messageID
        const isReverted = props.revertState.messageID && message.id >= props.revertState.messageID

        return (
          <Switch>
            <Match when={isRevertPoint}>
              <RevertPoint
                revertedCount={props.revertState.revertedMessages.length}
                diffFiles={props.revertState.diffFiles}
                onRestore={() => command.trigger("session.redo")}
              />
            </Match>
            <Match when={isReverted}>
              <></>
            </Match>
            <Match when={message.role === "user"}>
              <UserMessage
                index={index()}
                onMouseUp={() => props.onMessageClick(message)}
                message={sync.data.message[ctx.sessionID]?.find((m) => m.id === message.id) as UserMessage}
                parts={sync.data.part[message.id] ?? []}
                pending={props.pendingId}
              />
            </Match>
            <Match when={message.role === "assistant"}>
              <AssistantMessage
                last={props.lastAssistantId === message.id}
                message={sync.data.message[ctx.sessionID]?.find((m) => m.id === message.id) as AssistantMessage}
                parts={sync.data.part[message.id] ?? []}
              />
            </Match>
          </Switch>
        )
      }}
    </For>
  )
}

// RevertPoint 组件 - 显示 revert 状态
function RevertPoint(props: {
  revertedCount: number
  diffFiles: any[]
  onRestore: () => void
}) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const [hover, setHover] = createSignal(false)
  const dialog = useDialog()

  const handleUnrevert = async () => {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Confirm Redo",
      "Are you sure you want to restore the reverted messages?",
    )
    if (confirmed) {
      props.onRestore()
    }
  }

  return (
    <box
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={handleUnrevert}
      marginTop={1}
      flexShrink={0}
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.backgroundPanel}
    >
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
      >
        <text fg={theme.textMuted}>{props.revertedCount} message reverted</text>
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.text }}>{keybind.print("messages_redo")}</span> or /redo to restore
        </text>
        <Show when={props.diffFiles?.length}>
          <box marginTop={1}>
            <For each={props.diffFiles}>
              {(file) => (
                <text fg={theme.text}>
                  {file.filename}
                  <Show when={file.additions > 0}>
                    <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                  </Show>
                  <Show when={file.deletions > 0}>
                    <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                  </Show>
                </text>
              )}
            </For>
          </box>
        </Show>
      </box>
    </box>
  )
}
