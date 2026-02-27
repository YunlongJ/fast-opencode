import { useTheme } from "../context/theme"

export type TodoStatus = "pending" | "in_progress" | "completed"

export interface TodoItemProps {
  status: TodoStatus
  content: string
  index?: number
  isSelected?: boolean
}

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()

  const getStatusColor = () => {
    switch (props.status) {
      case "completed":
        return theme.success
      case "in_progress":
        return theme.warning
      case "pending":
      default:
        return theme.textMuted
    }
  }

  const getStatusIcon = () => {
    switch (props.status) {
      case "completed":
        return "✓"
      case "in_progress":
        return "◐"
      case "pending":
      default:
        return "○"
    }
  }

  const statusColor = getStatusColor()
  const contentColor = props.status === "completed" ? theme.textMuted : theme.text

  return (
    <box
      flexDirection="row"
      gap={1}
      paddingLeft={props.isSelected ? 1 : 0}
      style={{
        bg: props.isSelected ? theme.backgroundElement : undefined,
      }}
    >
      {props.index !== undefined && (
        <text
          flexShrink={0}
          style={{
            fg: theme.textMuted,
          }}
        >
          {props.index}.
        </text>
      )}
      <text
        flexShrink={0}
        style={{
          fg: statusColor,
          bold: props.status === "in_progress",
        }}
      >
        {getStatusIcon()}
      </text>
      <text
        flexGrow={1}
        wrapMode="word"
        style={{
          fg: contentColor,
          strikethrough: props.status === "completed",
        }}
      >
        {props.content}
      </text>
    </box>
  )
}
