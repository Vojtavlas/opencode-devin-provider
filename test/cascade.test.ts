import { describe, it, expect } from "bun:test";
import { createDevinCascadeProvider } from "../src/cascade.js";

/**
 * Simulate a Connect-streamed Cascade response.
 * Each frame: 1-byte flag + 4-byte big-endian length + payload.
 * Flag 0x00 = uncompressed protobuf data frame.
 * Flag 0x02 = end-of-stream JSON trailer.
 */
function connectFrame(payload: Uint8Array, flag: number = 0): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flag;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

function trailerFrame(json: string): Buffer {
  const payload = Buffer.from(json, "utf8");
  return connectFrame(payload, 0x02);
}

describe("Devin Cascade provider", () => {
  it("throws when api key is missing", async () => {
    const devin = createDevinCascadeProvider({});
    const model = devin("swe-1-6");

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
