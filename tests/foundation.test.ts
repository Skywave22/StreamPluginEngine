import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENGINE_NAME,
  ENGINE_PHASE,
  ENGINE_VERSION,
} from "../src/index.js";

test("foundation compiles and exports engine identity", () => {
  assert.equal(ENGINE_NAME, "stream-plugin-engine");
  assert.equal(ENGINE_VERSION, "0.1.0");
  assert.equal(ENGINE_PHASE, 3);
});
