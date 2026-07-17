import { describe, it, expect } from "bun:test";
import { createDevinProvider } from "../src/provider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Devin provider", () => {
  it("creates a session, polls messages, and emits text deltas", async () => {
    let sessionStatus = "running";
    let messageIndex = 0;

    const fetchImpl = async (
      url: string,
      init?: { method?: string },
    ): Promise<Response> => {
      const method = init?.method ?? "GET";

      if (method === "POST" && url.includes("/sessions")) {
        return jsonResponse({ session_id: "devin-abc", status: "running" });
      }

      if (method === "GET" && url.includes("/sessions/devin-abc/messages")) {
        messageIndex += 1;
        if (messageIndex === 1) {
          return jsonResponse({
            items: [
              {
                event_id: "m1",
                source: "devin",
                message: "Hello",
                created_at: 1,
              },
            ],
          });
        }
        return jsonResponse({
          items: [
            {
              event_id: "m1",
              source: "devin",
              message: "Hello",
              created_at: 1,
            },
            {
              event_id: "m2",
              source: "devin",
              message: " world",
              created_at: 2,
            },
          ],
        });
      }

      if (method === "GET" && url.endsWith("/sessions/devin-abc")) {
        const status = sessionStatus;
        sessionStatus = "exit";
        return jsonResponse({ session_id: "devin-abc", status });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };

    const devin = createDevinProvider({
      apiKey: "cog_test",
      orgId: "org_test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollIntervalMs: 10,
      maxPolls: 3,
    });

    const model = devin("devin");
    const { stream } = await model.doStream({
      inputFormat: "messages",
      mode: { type: "regular" },
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] },
      ],
    });

    const chunks: any[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const text = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.textDelta)
      .join("");

    expect(text).toBe("Hello world");
    expect(chunks.some((c) => c.type === "response-metadata" && c.id === "devin-abc")).toBe(true);
    expect(chunks.some((c) => c.type === "finish" && c.finishReason === "stop")).toBe(true);
  });

  it("throws when api key or org id are missing", async () => {
    const devin = createDevinProvider({});
    const model = devin("devin");

    await expect(
      model.doStream({
        inputFormat: "messages",
        mode: { type: "regular" },
        prompt: [
          { role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] },
        ],
      }),
    ).rejects.toThrow("Devin API key is required");
  });
});
