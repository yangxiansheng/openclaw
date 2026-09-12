import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectAuthStoreAssignments } from "./runtime-auth-collectors.js";
import { createResolverContext } from "./runtime-shared.js";

const NVIDIA_STORE_REF = {
  source: "store",
  provider: "default",
  id: "NVIDIA_API_KEY",
} as const;

type TestProfileStore = AuthProfileStore;

function buildStore(overrides?: Partial<TestProfileStore>): TestProfileStore {
  return {
    version: 1,
    profiles: {
      "nvidia:test": {
        type: "api_key",
        provider: "nvidia",
        keyRef: NVIDIA_STORE_REF,
      },
      "openai:test": {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    },
    ...overrides,
  };
}

type TestProfile = NonNullable<TestProfileStore["profiles"][string]>;

function storeWithExpiredToken(profiles: Record<string, TestProfile>): TestProfileStore {
  return {
    ...buildStore(),
    profiles: { ...buildStore().profiles, ...profiles },
  };
}

function collect(
  params: {
    config?: OpenClawConfig;
    allowOwnerIsolation?: boolean;
    pinnedProfileId?: string;
    store?: TestProfileStore;
  } = {},
): {
  assignments: Array<{ ref: { id: string } }>;
  warnings: Array<{ code: string; message: string }>;
} {
  const context = createResolverContext({
    sourceConfig: params.config ?? {},
    env: {},
    ...(params.allowOwnerIsolation !== undefined
      ? { allowOwnerIsolation: params.allowOwnerIsolation }
      : {}),
    ...(params.pinnedProfileId ? { pinnedProfileId: params.pinnedProfileId } : {}),
    manifestRegistry: { plugins: [] },
  });
  collectAuthStoreAssignments({
    store: params.store ?? buildStore(),
    context,
    agentDir: "/agents/main",
  });
  return {
    assignments: context.assignments.map((assignment) => ({
      ref: { id: assignment.ref.id },
    })),
    warnings: context.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
    })),
  };
}

function collectedProfileIds(result: { assignments: Array<{ ref: { id: string } }> }): string[] {
  return result.assignments.map((assignment) => assignment.ref.id);
}

describe("collectAuthStoreAssignments auth.order awareness", () => {
  it("excludes a profile omitted by an explicit provider auth.order on strict paths", () => {
    const result = collect({
      config: { auth: { order: { nvidia: [] } } },
    });
    expect(collectedProfileIds(result)).not.toContain("NVIDIA_API_KEY");
    expect(collectedProfileIds(result)).toContain("OPENAI_API_KEY");
    expect(
      result.warnings.some(
        (warning) =>
          warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE" &&
          warning.message.includes("Excluded by auth.order"),
      ),
    ).toBe(true);
  });

  it("collects widely when a provider has no explicit auth.order", () => {
    const result = collect();
    expect(collectedProfileIds(result)).toEqual(
      expect.arrayContaining(["NVIDIA_API_KEY", "OPENAI_API_KEY"]),
    );
    expect(
      result.warnings.some((warning) => warning.message.includes("Excluded by auth.order")),
    ).toBe(false);
  });

  it("keeps an eligibility-ineligible profile inactive regardless of auth.order", () => {
    const store = storeWithExpiredToken({
      "openai:expired": {
        type: "token",
        provider: "openai",
        tokenRef: { source: "env", provider: "default", id: "OPENAI_EXPIRED" },
        expires: Date.now() - 10_000,
      },
    });
    const result = collect({ store });
    expect(collectedProfileIds(result)).not.toContain("OPENAI_EXPIRED");
    expect(result.warnings.some((warning) => warning.message.includes("not eligible"))).toBe(true);
  });

  it("config-bound profile (models.providers.<id>.apiKey literal binding) is exempt from exclusion", () => {
    const result = collect({
      config: {
        auth: { order: { nvidia: [] } },
        models: { providers: { nvidia: { apiKey: "nvidia:test", baseUrl: "", models: [] } } },
      },
    });
    expect(collectedProfileIds(result)).toContain("NVIDIA_API_KEY");
  });

  it("a session-pinned profile is exempt from exclusion", () => {
    const result = collect({
      config: { auth: { order: { nvidia: [] } } },
      pinnedProfileId: "nvidia:test",
    });
    expect(collectedProfileIds(result)).toContain("NVIDIA_API_KEY");
  });

  it("allowOwnerIsolation (Gateway degrade path) keeps wide collection despite explicit order", () => {
    const result = collect({
      config: { auth: { order: { nvidia: [] } } },
      allowOwnerIsolation: true,
    });
    expect(collectedProfileIds(result)).toContain("NVIDIA_API_KEY");
  });
});
