import { describe, expect, test } from "bun:test";
import {
  deriveProjectNameFromPath,
  isAbsoluteLocalPath,
  slugifyProjectName,
} from "../src/lib/projectPath.ts";

describe("isAbsoluteLocalPath", () => {
  test("recognizes POSIX and home paths", () => {
    expect(isAbsoluteLocalPath("/home/dev/keelson")).toBe(true);
    expect(isAbsoluteLocalPath("~/keelson")).toBe(true);
    expect(isAbsoluteLocalPath("~")).toBe(true);
  });

  test("recognizes Windows drive-letter and UNC paths", () => {
    expect(isAbsoluteLocalPath("C:\\Users\\dascholl\\source\\keelson")).toBe(true);
    expect(isAbsoluteLocalPath("c:/Users/dascholl/keelson")).toBe(true);
    expect(isAbsoluteLocalPath("\\\\server\\share\\keelson")).toBe(true);
  });

  test("rejects non-paths (bare names, urls)", () => {
    expect(isAbsoluteLocalPath("keelson")).toBe(false);
    expect(isAbsoluteLocalPath("use foo")).toBe(false);
    expect(isAbsoluteLocalPath("https://github.com/danielscholl/keelson")).toBe(false);
  });
});

describe("deriveProjectNameFromPath", () => {
  test("derives the leaf dir from a Windows path", () => {
    expect(deriveProjectNameFromPath("C:\\Users\\dascholl\\source\\keelson")).toBe("keelson");
  });

  test("derives the leaf dir from a POSIX path", () => {
    expect(deriveProjectNameFromPath("/home/dev/My Repo")).toBe("my-repo");
  });

  test("tolerates trailing separators", () => {
    expect(deriveProjectNameFromPath("C:\\src\\keelson\\")).toBe("keelson");
    expect(deriveProjectNameFromPath("/home/dev/keelson/")).toBe("keelson");
  });
});

describe("slugifyProjectName", () => {
  test("folds into the project-name charset", () => {
    expect(slugifyProjectName("My_Repo 2!")).toBe("my_repo-2");
    expect(slugifyProjectName("--keelson--")).toBe("keelson");
  });
});
