import { describe, it, expect } from "bun:test";
import { createDevinCascadeProvider } from "../src/cascade.js";

describe("Devin Cascade provider", () => {
  it("throws when api key is missing", async () => {
    const devin = createDevinCascadeProvider({});
    const model = devin.languageModel("swe-1-7");

    await expect(
      model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "Hi" }] },
        ],
      }),
    ).rejects.toThrow("Devin API key is required");
  });

  it("has v3 specificationVersion", () => {
    const devin = createDevinCascadeProvider({});
    const model = devin.languageModel("swe-1-7");
    expect(model.specificationVersion).toBe("v3");
  });

  it("has supportedUrls", () => {
    const devin = createDevinCascadeProvider({});
    const model = devin.languageModel("swe-1-7");
    expect(model.supportedUrls).toBeDefined();
  });
});
