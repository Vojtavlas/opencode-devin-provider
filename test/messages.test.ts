import { describe, it, expect } from "bun:test";
import { renderPrompt } from "../src/messages.js";

describe("renderPrompt", () => {
  it("renders a simple user and assistant exchange", () => {
    const prompt = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Hello" }],
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Hi there" }],
      },
    ];

    const result = renderPrompt(prompt as any);
    expect(result).toContain("user: Hello");
    expect(result).toContain("assistant: Hi there");
  });

  it("renders images and files as placeholders", () => {
    const prompt = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "Look at this" },
          { type: "image" as const, image: new Uint8Array([1, 2, 3]) },
          { type: "file" as const, data: "abc", mimeType: "text/plain" },
        ],
      },
    ];

    const result = renderPrompt(prompt as any);
    expect(result).toContain("user: Look at this[image][file: text/plain]");
  });

  it("renders system message", () => {
    const prompt = [
      { role: "system" as const, content: "You are helpful." },
    ];

    const result = renderPrompt(prompt as any);
    expect(result).toBe("system: You are helpful.");
  });
});
