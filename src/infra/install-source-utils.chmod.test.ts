// Covers the regression fix for #101224: parent temp root permissions are
// preserved when withTempDir uses the private OpenClaw temp root.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn());

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tmp-openclaw-dir.js")>();
  return {
    ...actual,
    resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
  };
});

import { withTempDir } from "./install-source-utils.js";

describe("withTempDir (#101224 regression)", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("preserves parent temp root permissions when using private OpenClaw temp root", async () => {
    const mockParentRoot = tempDirs.make("openclaw-chmod-test-");
    const mockOpenClawDir = path.join(mockParentRoot, "openclaw");

    await fs.mkdir(mockOpenClawDir, { recursive: true });
    await fs.chmod(mockParentRoot, 0o1777);

    resolvePreferredOpenClawTmpDirMock.mockReturnValue(mockOpenClawDir);

    let observedDir = "";
    const value = await withTempDir("openclaw-test-", async (tmpDir) => {
      observedDir = tmpDir;
      expect(tmpDir.startsWith(mockOpenClawDir)).toBe(true);
      await fs.writeFile(path.join(tmpDir, "marker.txt"), "ok");
      return "done";
    });

    expect(value).toBe("done");

    // Verify the temp workspace was cleaned up
    await expect(
      fs.stat(observedDir).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);

    // Verify parent temp root permissions are preserved (0o1777)
    const parentStat = await fs.stat(mockParentRoot);
    expect(parentStat.mode & 0o777).toBe(0o777);
  });
});
