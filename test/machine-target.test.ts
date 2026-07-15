import assert from "node:assert/strict";
import test from "node:test";
import {
  loadMachineTargetId,
  loadMachineTargetPickerExpanded,
  machineTargetPickerExpandedStorageKey,
  machineTargetStorageKey,
  persistMachineTargetId,
  persistMachineTargetPickerExpanded,
  resolveMachineTargetId,
} from "../src/client/src/machine-target.js";

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
};

test("remote-only machine lists replace a stale local creation target", () => {
  const machines = [{ id: "remote" }, { id: "backup" }];
  assert.equal(resolveMachineTargetId("local", machines), "remote");
});

test("implicit target reconciliation prefers an online registered machine", () => {
  const machines = [
    { id: "stale", source: "registered" as const, online: false },
    { id: "live", source: "registered" as const, online: true },
  ];
  assert.equal(resolveMachineTargetId("stale", machines), "live");
});

test("implicit target reconciliation rejects an all-offline registered catalog", () => {
  const machines = [{ id: "stale", source: "registered" as const, online: false }];
  assert.equal(resolveMachineTargetId("stale", machines), "");
});

test("an available explicit creation target remains selected", () => {
  const machines = [{ id: "remote" }, { id: "backup" }];
  assert.equal(resolveMachineTargetId("backup", machines), "backup");
});

test("zero-machine lists do not produce an invalid creation target", () => {
  assert.equal(resolveMachineTargetId("local", []), "");
});

test("the last target host can be restored from browser storage", () => {
  const storage = memoryStorage({ [machineTargetStorageKey]: "backup" });
  const restored = loadMachineTargetId(storage);

  assert.equal(restored, "backup");
  assert.equal(resolveMachineTargetId(restored, [{ id: "remote" }, { id: "backup" }]), "backup");
});

test("a missing saved target reconciles to a valid host", () => {
  const storage = memoryStorage({ [machineTargetStorageKey]: "removed" });
  const restored = loadMachineTargetId(storage);

  assert.equal(resolveMachineTargetId(restored, [{ id: "remote" }, { id: "backup" }]), "remote");
});

test("target persistence saves valid selections and clears an empty catalog", () => {
  const storage = memoryStorage();

  persistMachineTargetId(storage, " backup ");
  assert.equal(loadMachineTargetId(storage), "backup");

  persistMachineTargetId(storage, "");
  assert.equal(loadMachineTargetId(storage), "");
});

test("unavailable browser storage does not prevent target selection", () => {
  const unavailable = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };

  assert.equal(loadMachineTargetId(unavailable), "");
  assert.doesNotThrow(() => persistMachineTargetId(unavailable, "remote"));
});

test("the target host picker restores its expanded state", () => {
  const storage = memoryStorage({ [machineTargetPickerExpandedStorageKey]: "true" });

  assert.equal(loadMachineTargetPickerExpanded(storage), true);
  persistMachineTargetPickerExpanded(storage, false);
  assert.equal(loadMachineTargetPickerExpanded(storage), false);
});

test("invalid or unavailable picker storage defaults to collapsed", () => {
  const invalid = memoryStorage({ [machineTargetPickerExpandedStorageKey]: "expanded" });
  const unavailable = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };

  assert.equal(loadMachineTargetPickerExpanded(invalid), false);
  assert.equal(loadMachineTargetPickerExpanded(unavailable), false);
  assert.doesNotThrow(() => persistMachineTargetPickerExpanded(unavailable, true));
});
