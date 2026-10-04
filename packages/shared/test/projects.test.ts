import { describe, expect, it } from "bun:test";
import {
  cloneProjectBodySchema,
  createProjectBodySchema,
  ProjectOperationError,
} from "../src/projects.ts";

describe("project request contracts", () => {
  it("accepts name-only and explicit-root creation", () => {
    expect(createProjectBodySchema.parse({ name: "demo" })).toEqual({ name: "demo" });
    expect(createProjectBodySchema.parse({ name: "demo", rootPath: "/workspace/demo" })).toEqual({
      name: "demo",
      rootPath: "/workspace/demo",
    });
  });

  it("rejects invalid names, roots, and unknown fields", () => {
    for (const body of [
      {},
      { name: "" },
      { name: "Upper" },
      { name: "../demo" },
      { name: "x".repeat(65) },
      { name: "demo", rootPath: "" },
      { name: "demo", rootPath: null },
      { name: "demo", extra: true },
    ]) {
      expect(createProjectBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it("preserves strict clone input with optional names", () => {
    expect(cloneProjectBodySchema.parse({ url: "/source/demo.git" })).toEqual({
      url: "/source/demo.git",
    });
    expect(cloneProjectBodySchema.parse({ url: "/source", name: "demo" }).name).toBe("demo");
    for (const body of [{}, { url: "" }, { url: "/source", name: "Bad" }, { url: "x", extra: 1 }]) {
      expect(cloneProjectBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it("exposes typed operation failures", () => {
    const error = new ProjectOperationError(409, "Project already exists");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ProjectOperationError");
    expect(error.status).toBe(409);
    expect(error.message).toBe("Project already exists");
  });
});
