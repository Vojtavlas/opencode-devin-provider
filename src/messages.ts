import type {
  LanguageModelV1Prompt,
  LanguageModelV1TextPart,
  LanguageModelV1ImagePart,
  LanguageModelV1FilePart,
  LanguageModelV1ToolCallPart,
  LanguageModelV1ToolResultPart,
} from "@ai-sdk/provider";

function stringifyUserPart(
  part:
    | LanguageModelV1TextPart
    | LanguageModelV1ImagePart
    | LanguageModelV1FilePart,
): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "image":
      return "[image]";
    case "file":
      return `[file: ${part.mimeType}]`;
    default:
      return "";
  }
}

function stringifyAssistantPart(
  part:
    | LanguageModelV1TextPart
    | LanguageModelV1FilePart
    | LanguageModelV1ToolCallPart
    | { type: "reasoning"; text?: string }
    | { type: "redacted-reasoning"; data: string },
): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "file":
      return `[file: ${(part as LanguageModelV1FilePart).mimeType}]`;
    case "tool-call":
      return `[tool-call: ${part.toolName}(${JSON.stringify(part.args)})]`;
    case "reasoning":
      return "[reasoning]";
    case "redacted-reasoning":
      return "[redacted-reasoning]";
    default:
      return "";
  }
}

function stringifyToolPart(part: LanguageModelV1ToolResultPart): string {
  return `[tool-result: ${part.toolName} = ${JSON.stringify(part.result)}]`;
}

/**
 * Render an AI-SDK prompt into a single string suitable for Devin's session prompt.
 */
export function renderPrompt(prompt: LanguageModelV1Prompt): string {
  const lines: string[] = [];

  for (const message of prompt) {
    switch (message.role) {
      case "system": {
        lines.push(`system: ${message.content}`);
        break;
      }
      case "user": {
        const text = message.content.map(stringifyUserPart).join("");
        lines.push(`user: ${text}`);
        break;
      }
      case "assistant": {
        const text = message.content.map(stringifyAssistantPart).join("");
        lines.push(`assistant: ${text}`);
        break;
      }
      case "tool": {
        const text = message.content.map(stringifyToolPart).join("");
        lines.push(`tool: ${text}`);
        break;
      }
    }
  }

  return lines.join("\n\n");
}
