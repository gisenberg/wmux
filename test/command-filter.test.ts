import assert from "node:assert/strict";
import { test } from "node:test";
import { filterCommands } from "../src/client/src/command-filter.js";

const commands = [
  {
    title: "Rename current workspace",
    subtitle: "Add workspace rename command",
    section: "Actions",
    keywords: ["name", "title"],
  },
  {
    title: "Copy active session link",
    subtitle: "Add workspace rename command",
    section: "Actions",
    keywords: ["url", "share"],
  },
  {
    title: "Split right on haswell.internal",
    subtitle: "Add workspace rename command",
    section: "Pane",
  },
  {
    title: "Close current workspace",
    subtitle: "Add workspace rename command",
    section: "Close",
  },
  {
    title: "Open workspace: Add workspace rename command",
    subtitle: "haswell.internal",
    section: "Workspaces",
  },
  {
    title: "Open tab: Add workspace rename command",
    subtitle: "Add workspace rename command",
    section: "Tabs",
  },
];

test("command filtering ignores display-only contextual subtitles", () => {
  assert.deepEqual(filterCommands(commands, "rena").map((command) => command.title), [
    "Rename current workspace",
    "Open workspace: Add workspace rename command",
    "Open tab: Add workspace rename command",
  ]);
});

test("command filtering retains explicit metadata matches", () => {
  assert.deepEqual(filterCommands(commands, "share").map((command) => command.title), ["Copy active session link"]);
  assert.deepEqual(filterCommands(commands, "close").map((command) => command.title), ["Close current workspace"]);
});
