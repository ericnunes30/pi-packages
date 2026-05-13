import { describe, it } from "node:test";
import assert from "node:assert";

// Replicate the helper functions to test since index.ts is the extension entry point
function extractText(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ");
  }
  return "";
}

function mapRole(role: string): string {
  switch (role) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "toolResult":
    case "bashExecution": return "tool";
    default: return "tool";
  }
}

describe("extractText helper", () => {
  it("should extract text from string content", () => {
    assert.strictEqual(extractText({ content: "Hello world" }), "Hello world");
  });

  it("should extract text from array of content blocks", () => {
    const msg = {
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: "world" },
        { type: "image", url: "..." },
      ],
    };
    assert.strictEqual(extractText(msg), "Hello world");
  });

  it("should return empty string for empty content", () => {
    assert.strictEqual(extractText({ content: "" }), "");
  });

  it("should return empty string for missing content", () => {
    assert.strictEqual(extractText({}), "");
  });

  it("should return empty string for null content", () => {
    assert.strictEqual(extractText({ content: null }), "");
  });
});

describe("mapRole helper", () => {
  it("should map 'user' to 'user'", () => {
    assert.strictEqual(mapRole("user"), "user");
  });

  it("should map 'assistant' to 'assistant'", () => {
    assert.strictEqual(mapRole("assistant"), "assistant");
  });

  it("should map 'toolResult' to 'tool'", () => {
    assert.strictEqual(mapRole("toolResult"), "tool");
  });

  it("should map 'bashExecution' to 'tool'", () => {
    assert.strictEqual(mapRole("bashExecution"), "tool");
  });

  it("should map unknown roles to 'tool' (default)", () => {
    assert.strictEqual(mapRole("custom"), "tool");
    assert.strictEqual(mapRole("unknown"), "tool");
  });
});
