// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import { describe, expect, test } from "bun:test";
import { type CredentialStore, createRibCredentialAccessor } from "../src/credentials.ts";

function fakeStore(values: Record<string, string>): {
  store: CredentialStore;
  gets: string[];
} {
  const gets: string[] = [];
  const store: CredentialStore = {
    get: async (serviceId) => {
      gets.push(serviceId);
      return values[serviceId];
    },
    set: async () => {},
    delete: async () => false,
  };
  return { store, gets };
}

describe("createRibCredentialAccessor", () => {
  test("reads from the rib-namespaced keyring account", async () => {
    const { store, gets } = fakeStore({ rib_osdu_token: "secret" });
    const read = createRibCredentialAccessor(store, "osdu");
    expect(await read("token")).toBe("secret");
    expect(gets).toEqual(["rib_osdu_token"]);
  });

  test("hyphenated ids resolve to unambiguous, non-colliding accounts", async () => {
    const { store } = fakeStore({ "rib_osdu-prod_token": "A", "rib_osdu_prod-token": "B" });
    expect(await createRibCredentialAccessor(store, "osdu-prod")("token")).toBe("A");
    expect(await createRibCredentialAccessor(store, "osdu")("prod-token")).toBe("B");
  });

  test("returns undefined for an unset credential", async () => {
    const { store } = fakeStore({});
    const read = createRibCredentialAccessor(store, "osdu");
    expect(await read("token")).toBeUndefined();
  });

  test("two ribs resolve to distinct accounts", async () => {
    const { store, gets } = fakeStore({ rib_a_token: "A", rib_b_token: "B" });
    expect(await createRibCredentialAccessor(store, "a")("token")).toBe("A");
    expect(await createRibCredentialAccessor(store, "b")("token")).toBe("B");
    expect(gets).toEqual(["rib_a_token", "rib_b_token"]);
  });

  test("rejects an invalid serviceId without touching the store", async () => {
    const { store, gets } = fakeStore({});
    const read = createRibCredentialAccessor(store, "osdu");
    await expect(read("Bad_Id")).rejects.toThrow(/invalid rib credential serviceId/);
    expect(gets).toEqual([]);
  });

  test("throws synchronously on an invalid rib id", () => {
    const { store } = fakeStore({});
    expect(() => createRibCredentialAccessor(store, "Bad_Rib")).toThrow();
  });
});
