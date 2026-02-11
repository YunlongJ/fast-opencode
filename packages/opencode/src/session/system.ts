import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"

import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_MEMORY_MARKERS from "../agent/prompt/memory-markers.txt"
import type { Provider } from "@/provider/provider"

const CODE_GENERATION_GUIDELINES = `
# Code Generation Strategy

## Prefer Small, Incremental Changes
- **AVOID generating large blocks of code** in a single response
- **Prefer multiple small Edit calls** over one large Write call
- Each code change should be focused and atomic
- When modifying files, make minimal changes to achieve the goal

## Edit vs Write Guidelines
- **Use Edit tool** for modifying existing files - it preserves context and reduces token usage
- **Use Write tool** only when creating entirely new files or doing complete rewrites
- Break large changes into a series of smaller, targeted edits
- Each edit should change only what's necessary

## Response Efficiency
- Keep code generation responses short and focused
- Generate code in small, reviewable chunks
- Prefer iterative refinement over bulk generation
- This approach improves accuracy and reduces errors
`.trim()

export namespace SystemPrompt {
  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function provider(model: Provider.Model) {
    const prompts = []

    // Add memory markers prompt for all models
    prompts.push(PROMPT_MEMORY_MARKERS)

    // Add code generation guidelines for all models
    prompts.push(CODE_GENERATION_GUIDELINES)

    if (model.api.id.includes("gpt-5")) prompts.push(PROMPT_CODEX)
    else if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      prompts.push(PROMPT_BEAST)
    else if (model.api.id.includes("gemini-")) prompts.push(PROMPT_GEMINI)
    else prompts.push(PROMPT_ANTHROPIC_WITHOUT_TODO)

    return prompts
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: Instance.directory,
                limit: 50,
              })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }
}
