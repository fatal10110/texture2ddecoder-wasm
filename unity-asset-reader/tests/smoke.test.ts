import { describe, it } from "node:test";
import assert from "node:assert";
import * as reader from "../src/index.js";

describe("scaffold", () => {
  it("loads the entry module", () => {
    assert.ok(reader);
  });
});
