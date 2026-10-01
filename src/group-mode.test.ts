import { describe, expect, test } from "bun:test";
import { createGroupModeRequestGate, groupModeDraftIsDirty } from "./App";

const savedRun = {
  id: "run-1",
  name: "September workshop",
  status: "draft" as const,
  initialStage: "open_play",
  selectedProjectIds: ["team-3", "team-2"],
  results: [],
  createdAt: 1,
  updatedAt: 2,
};

describe("Group Mode client lifecycle", () => {
  test("rehydrates the durable name and selected projects after a remount or refresh", () => {
    const firstMount = createGroupModeRequestGate();
    const firstLoad = firstMount.begin();
    expect(firstMount.acceptsDraftHydration(firstLoad)).toBeTrue();
    expect(groupModeDraftIsDirty(savedRun, savedRun.name, savedRun.selectedProjectIds)).toBeFalse();

    const remount = createGroupModeRequestGate();
    const refreshLoad = remount.begin();
    expect(remount.acceptsDraftHydration(refreshLoad)).toBeTrue();
    expect(groupModeDraftIsDirty(savedRun, "", [])).toBeTrue();
  });

  test("does not let a late GET erase checkbox edits or a stale request overwrite newer feedback", () => {
    const gate = createGroupModeRequestGate();
    const hydration = gate.begin();
    gate.edited();
    expect(gate.acceptsDraftHydration(hydration)).toBeFalse();

    const save = gate.begin();
    const command = gate.begin();
    expect(gate.accepts(save)).toBeFalse();
    expect(gate.accepts(command)).toBeTrue();
  });

  test("distinguishes edited checkbox state from the durable command target", () => {
    expect(groupModeDraftIsDirty(savedRun, savedRun.name, ["team-3"])).toBeTrue();
    expect(groupModeDraftIsDirty(savedRun, "Renamed workshop", savedRun.selectedProjectIds)).toBeTrue();
    expect(groupModeDraftIsDirty(savedRun, savedRun.name, ["team-3", "team-2"])).toBeFalse();
  });
});
