import { describe, expect, it } from "vitest";
import { generateApiKey, parseApiKey } from "./api-keys";

describe("api keys", () => {
  it("round-trips the generated key format", () => {
    const { key, prefix } = generateApiKey();
    const parsed = parseApiKey(key);
    expect(parsed?.prefix).toBe(prefix);
    expect(key.startsWith(`qms_${prefix}_`)).toBe(true);
  });

  it("rejects malformed keys", () => {
    expect(parseApiKey("Bearer nonsense")).toBeNull();
    expect(parseApiKey("qms_zzzzzzzz_short")).toBeNull();
  });
});
