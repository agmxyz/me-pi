import { test } from "node:test";
import assert from "node:assert/strict";
import { greet } from "./cli.js";

test("greets the world by default", () => assert.equal(greet(), "Hello, world!"));
test("greets a name", () => assert.equal(greet("Ada"), "Hello, Ada!"));
