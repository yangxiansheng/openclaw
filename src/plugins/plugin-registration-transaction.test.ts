import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPluginSessionSchedulerJob } from "./host-hook-runtime.js";
import { listPluginSessionSchedulerJobs } from "./host-hook-runtime.test-fixtures.js";
import { clearActivatedPluginRuntimeState } from "./loader-shared.js";
import {
  getMemoryCapabilityRegistration,
  registerMemoryCapability,
} from "./memory-state.test-fixtures.js";
import {
  createPluginRegistrationTransaction,
  type PluginProcessGlobalState,
  restorePluginProcessGlobalState,
  snapshotPluginProcessGlobalState,
} from "./plugin-registration-transaction.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRegistry } from "./registry.js";
import {
  getSessionDiscussionProvider,
  registerSessionDiscussionProvider,
  type SessionDiscussionProvider,
} from "./session-discussion-registry.js";

function discussionProvider(id: string): SessionDiscussionProvider {
  return {
    id,
    info: vi.fn().mockResolvedValue({ state: "available" }),
    open: vi.fn().mockResolvedValue({ state: "open" }),
  };
}

describe("plugin registration transaction", () => {
  let initialProcessGlobalState: PluginProcessGlobalState;

  beforeEach(() => {
    initialProcessGlobalState = snapshotPluginProcessGlobalState();
  });

  afterEach(() => {
    restorePluginProcessGlobalState(initialProcessGlobalState);
  });

  it("rolls back registry writes and restores prior process-global capability state", () => {
    const registry = createEmptyPluginRegistry();
    const activePromptBuilder = () => ["active"];
    const failedResolver = () => "failed";
    const rollbackGlobalSideEffects = vi.fn();
    registerMemoryCapability("active-memory", { promptBuilder: activePromptBuilder });

    const transaction = createPluginRegistrationTransaction({
      registry,
      rollbackGlobalSideEffects,
    });
    registry.hostedMediaResolvers.push({
      pluginId: "failed-plugin",
      resolver: failedResolver,
      source: "failed-plugin",
    });
    registry.gatewayHandlers.failed = async () => {};
    registerMemoryCapability("failed-memory", { promptBuilder: () => ["failed"] });

    transaction.rollback();

    expect(rollbackGlobalSideEffects).toHaveBeenCalledOnce();
    expect(registry.hostedMediaResolvers).toStrictEqual([]);
    expect(registry.gatewayHandlers).toStrictEqual({});
    expect(getMemoryCapabilityRegistration()).toEqual({
      pluginId: "active-memory",
      capability: { promptBuilder: activePromptBuilder },
    });
  });

  it("keeps snapshot registry writes while restoring globals for non-activating commits", () => {
    const registry = createEmptyPluginRegistry();
    const activePromptBuilder = () => ["active"];
    const snapshotResolver = () => "snapshot";
    registerMemoryCapability("active-memory", { promptBuilder: activePromptBuilder });

    const transaction = createPluginRegistrationTransaction({ registry });
    registry.hostedMediaResolvers.push({
      pluginId: "snapshot-plugin",
      resolver: snapshotResolver,
      source: "snapshot-plugin",
    });
    registerMemoryCapability("snapshot-memory", { promptBuilder: () => ["snapshot"] });

    transaction.commit({ activate: false });

    expect(registry.hostedMediaResolvers).toEqual([
      {
        pluginId: "snapshot-plugin",
        resolver: snapshotResolver,
        source: "snapshot-plugin",
      },
    ]);
    expect(getMemoryCapabilityRegistration()).toEqual({
      pluginId: "active-memory",
      capability: { promptBuilder: activePromptBuilder },
    });
  });

  it("clears the discussion provider before repeated active plugin activation", () => {
    registerSessionDiscussionProvider(discussionProvider("clickclack"));

    clearActivatedPluginRuntimeState();

    expect(getSessionDiscussionProvider()).toBeUndefined();
  });

  it("restores the prior discussion provider when plugin activation rolls back", () => {
    const activeProvider = discussionProvider("clickclack");
    registerSessionDiscussionProvider(activeProvider);
    const transaction = createPluginRegistrationTransaction({});
    registerSessionDiscussionProvider(discussionProvider("replacement"));

    transaction.rollback();

    expect(getSessionDiscussionProvider()).toBe(activeProvider);
  });

  it("rolls back session scheduler jobs during plugin registration rollback", async () => {
    const cleanup = vi.fn();
    const registry = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as import("./runtime/types.js").PluginRuntime,
    });
    const transaction = createPluginRegistrationTransaction({
      registry: registry.registry,
      rollbackGlobalSideEffects: () => registry.rollbackPluginGlobalSideEffects("scheduler-plugin"),
    });

    registry.registry.sessionSchedulerJobs.push({
      pluginId: "scheduler-plugin",
      pluginName: "Scheduler Plugin",
      job: {
        id: "test-job",
        sessionKey: "agent:main:main",
        kind: "monitor",
        cleanup,
      },
      source: "scheduler-plugin",
      rootDir: "/tmp",
    });

    registerPluginSessionSchedulerJob({
      pluginId: "scheduler-plugin",
      pluginName: "Scheduler Plugin",
      job: {
        id: "test-job",
        sessionKey: "agent:main:main",
        kind: "monitor",
        cleanup,
      },
    });

    expect(listPluginSessionSchedulerJobs("scheduler-plugin")).toEqual([
      {
        id: "test-job",
        pluginId: "scheduler-plugin",
        sessionKey: "agent:main:main",
        kind: "monitor",
      },
    ]);

    transaction.rollback();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(listPluginSessionSchedulerJobs("scheduler-plugin")).toStrictEqual([]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith({
      reason: "disable",
      sessionKey: "agent:main:main",
      jobId: "test-job",
    });
  });
});
