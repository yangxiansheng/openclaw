/** Tier 2 harness real-flow tests for issue #145740 (Fix A: auth.order exclusion; Fix B: store ref owner-env read-through). */
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withAuthProfileStoreAgentDir } from "../agents/auth-profiles.js";
import type { ApiKeyCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareSecretsRuntimeSnapshot } from "./runtime.js";
import { readSecretStoreValue, writeSecretStoreEntry } from "./store/secret-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const NVIDIA_STORE_REF = { source: "store", provider: "default", id: "NVIDIA_API_KEY" } as const;
const OPENAI_ENV_REF = { source: "env", provider: "default", id: "OPENAI_API_KEY" } as const;

function nvidiaStoreEntry(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "nvidia:test": {
        type: "api_key",
        provider: "nvidia",
        keyRef: { ...NVIDIA_STORE_REF },
      },
    },
  };
}

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("auth-profile store ref resolution (issue #145740)", () => {
  it("does not resolve an unrelated auth.order-excluded profile (no SECRET_REF_NOT_FOUND)", async () => {
    const ownerStateDir = tempDirs.make("t2-owner-state-");
    const tempStateDir = tempDirs.make("t2-temp-state-");

    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "NVIDIA_API_KEY",
      value: "nvidia-secret",
      kind: "secret",
      updatedBy: "test",
      database: { env: { OPENCLAW_STATE_DIR: ownerStateDir } },
    });

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "nvidia:test": {
          type: "api_key",
          provider: "nvidia",
          keyRef: { ...NVIDIA_STORE_REF },
        },
        "openai:test": {
          type: "api_key",
          provider: "openai",
          keyRef: { ...OPENAI_ENV_REF },
        },
      },
    };

    const config = asConfig({
      auth: { order: { nvidia: [] } },
    });

    const snapshot = await withAuthProfileStoreAgentDir("/agents/main", ownerStateDir, async () => {
      const result = await prepareSecretsRuntimeSnapshot({
        config,
        env: { OPENCLAW_STATE_DIR: tempStateDir, OPENAI_API_KEY: "openai-key" },
        agentDirs: ["/agents/main"],
        includeConfigRefs: false,
        loadAuthStore: () => store,
      });
      return result;
    });

    const openaiProfile = snapshot.authStores
      .map((entry) => entry.store.profiles["openai:test"])
      .find(
        (profile): profile is ApiKeyCredential =>
          profile?.type === "api_key" && profile.key === "openai-key",
      );
    expect(openaiProfile?.key).toBe("openai-key");

    const nvidiaProfile = snapshot.authStores
      .map((entry) => entry.store.profiles["nvidia:test"])
      .find((profile): profile is ApiKeyCredential => profile?.type === "api_key");
    expect(nvidiaProfile?.key).toBeUndefined();
  });

  it("resolves a selected profile store ref through the owner env, leaving the temp DB unchanged", async () => {
    const ownerStateDir = tempDirs.make("t3-owner-state-");
    const tempStateDir = tempDirs.make("t3-temp-state-");

    writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "NVIDIA_API_KEY",
      value: "nvidia-secret",
      kind: "secret",
      updatedBy: "test",
      database: { env: { OPENCLAW_STATE_DIR: ownerStateDir } },
    });

    const tempRead = readSecretStoreValue({
      scope: { kind: "team" },
      name: "NVIDIA_API_KEY",
      database: { env: { OPENCLAW_STATE_DIR: tempStateDir } },
    });
    expect(tempRead.ok).toBe(false);

    const config = asConfig({
      auth: { order: { nvidia: ["nvidia:test"] } },
    });

    const snapshot = await withAuthProfileStoreAgentDir("/agents/main", ownerStateDir, async () => {
      const result = await prepareSecretsRuntimeSnapshot({
        config,
        env: { OPENCLAW_STATE_DIR: tempStateDir },
        agentDirs: ["/agents/main"],
        includeConfigRefs: false,
        loadAuthStore: () => nvidiaStoreEntry(),
      });
      return result;
    });

    const nvidiaProfile = snapshot.authStores
      .map((entry) => entry.store.profiles["nvidia:test"])
      .find(
        (profile): profile is ApiKeyCredential =>
          profile?.type === "api_key" && profile.key === "nvidia-secret",
      );
    expect(nvidiaProfile?.key).toBe("nvidia-secret");

    const tempReadAfter = readSecretStoreValue({
      scope: { kind: "team" },
      name: "NVIDIA_API_KEY",
      database: { env: { OPENCLAW_STATE_DIR: tempStateDir } },
    });
    expect(tempReadAfter.ok).toBe(false);
  });
});
