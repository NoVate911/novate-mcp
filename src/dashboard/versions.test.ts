import { describe, expect, test } from "bun:test";
import {
  compareVersions, fetchReleases, installedVersion, isVersionTag, loadVersionsInfo,
  versionCanBeDeployed,
} from "./versions.ts";

const releases = [
  {
    tag_name: "26.9.2.010", name: "Новый релиз", body: "Исправления и улучшения",
    html_url: "https://github.com/NoVate911/novate-mcp/releases/tag/26.9.2.010",
    published_at: "2026-09-10T12:00:00Z", draft: false, prerelease: false,
  },
  {
    tag_name: "26.8.1.001", name: "Первый релиз", body: "Начальная версия",
    html_url: "https://github.com/NoVate911/novate-mcp/releases/tag/26.8.1.001",
    published_at: "2026-08-30T12:00:00Z", draft: false, prerelease: false,
  },
  { tag_name: "invalid", draft: false, prerelease: false },
  { tag_name: "26.10.1.001", draft: true, prerelease: false },
];

const fakeFetch = async (): Promise<Response> => new Response(JSON.stringify(releases), { status: 200 });

describe("versions", () => {
  test("проверяет и сравнивает версии", () => {
    expect(isVersionTag("26.8.1.001")).toBe(true);
    expect(isVersionTag("latest")).toBe(false);
    expect(compareVersions("26.10.1.001", "26.9.9.999")).toBeGreaterThan(0);
    expect(compareVersions("26.8.1.001", "26.8.1.001")).toBe(0);
  });

  test("читает установленный канал только из допустимого значения", () => {
    expect(installedVersion({ NOVATE_VERSION: "26.8.1.001" })).toBe("26.8.1.001");
    expect(installedVersion({ NOVATE_VERSION: "latest" })).toBe("latest");
    expect(installedVersion({ NOVATE_VERSION: "$(touch /tmp/x)" })).toBe("latest");
  });

  test("фильтрует GitHub Releases и сортирует их", async () => {
    const result = await fetchReleases(fakeFetch);
    expect(result.map((release) => release.version)).toEqual(["26.9.2.010", "26.8.1.001"]);
  });

  test("разрешает deploy только опубликованного релиза", async () => {
    expect(await versionCanBeDeployed("26.9.2.010", fakeFetch)).toBe(true);
    expect(await versionCanBeDeployed("26.7.1.001", fakeFetch)).toBe(false);
    expect(await versionCanBeDeployed("latest", fakeFetch)).toBe(false);
  });

  test("обнаруживает обновление для закреплённой версии", async () => {
    const previous = process.env.NOVATE_VERSION;
    process.env.NOVATE_VERSION = "26.8.1.001";
    try {
      const info = await loadVersionsInfo(fakeFetch);
      expect(info.latest?.version).toBe("26.9.2.010");
      expect(info.updateAvailable).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NOVATE_VERSION;
      else process.env.NOVATE_VERSION = previous;
    }
  });
});
