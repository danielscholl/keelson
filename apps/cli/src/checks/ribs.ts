// Copyright 2026, Daniel Scholl
//
// Licensed under the Apache License, Version 2.0 (the "License").

import type { ListRibsResponse, RibSummary } from "@keelson/shared";
import {
  type CrossRibGrants,
  crossRibGrantsFromConfig,
  readKeelsonConfig as defaultReadConfig,
  type ReadKeelsonConfigResult,
} from "@keelson/shared/config";
import { fetchRibs as defaultFetchRibs } from "../http/ribs-client.ts";
import {
  probeServer as defaultProbeServer,
  type ProbeOptions,
  type ServerInfo,
} from "../server-probe.ts";
import type { CategoryResult, CheckResult } from "./types.ts";

export type ProbeServer = (opts?: ProbeOptions) => Promise<ServerInfo | null>;
export type FetchRibs = (baseUrl: string) => Promise<ListRibsResponse>;

export interface RibsDeps {
  probeServer?: ProbeServer;
  fetchRibs?: FetchRibs;
  baseUrl?: string;
  readConfig?: () => ReadKeelsonConfigResult;
}

export async function runRibsCheck(deps: RibsDeps = {}): Promise<CategoryResult> {
  const probe = deps.probeServer ?? defaultProbeServer;
  const fetchRibs = deps.fetchRibs ?? defaultFetchRibs;
  const info = await probe(deps.baseUrl ? { baseUrl: deps.baseUrl } : {});

  // Ribs only activate inside the server, so there's nothing to report when it's
  // down. Skip (not warn) — the server check already owns the single down warning.
  if (!info) {
    return {
      category: "ribs",
      checks: [
        {
          name: "rib readiness",
          status: "skip",
          detail: "server not running; readiness and cross-rib grants are only observable from one",
          hint: "run `keelson start`, then re-run doctor to probe rib readiness and cross-rib grants",
        },
      ],
    };
  }

  let response: ListRibsResponse;
  try {
    response = await fetchRibs(info.baseUrl);
  } catch (err) {
    return {
      category: "ribs",
      checks: [
        {
          name: "rib readiness",
          status: "warn",
          detail: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
  const ribs = response.ribs;

  // Not-ready is a warn, never a hard fail — installed-but-unready is the
  // operator's to resolve; a rib with no probe reports no readiness, so skip it.
  const checks: CheckResult[] =
    ribs.length === 0
      ? [{ name: "rib readiness", status: "skip", detail: "no ribs installed" }]
      : ribs.map((rib): CheckResult => {
          if (!rib.auth) {
            return { name: rib.displayName, status: "skip", detail: "no readiness probe" };
          }
          if (rib.auth.authenticated) {
            return {
              name: rib.displayName,
              status: "ok",
              ...(rib.auth.statusMessage ? { detail: rib.auth.statusMessage } : {}),
            };
          }
          return {
            name: rib.displayName,
            status: "warn",
            detail: rib.auth.statusMessage ?? "not ready",
          };
        });

  const readConfig = deps.readConfig ?? defaultReadConfig;
  checks.push(...crossRibGrantChecks(ribs, response.crossRibGrants, readConfig()));

  return { category: "ribs", checks };
}

const NO_TOOLS: ReadonlySet<string> = new Set();

function describeTools(tools: ReadonlySet<string>, target: string): string {
  return tools.has("*") ? `every tool '${target}' owns` : [...tools].join(", ");
}

function quoteList(names: readonly string[]): string {
  return names.map((n) => `'${n}'`).join(", ");
}

// Tool names in `tools` that `covering` does not cover. Only a "*" in `covering`
// covers everything; a "*" in `tools` is a name like any other, uncovered unless
// `covering` carries one too.
function notCoveredBy(tools: ReadonlySet<string>, covering: ReadonlySet<string>): string[] {
  if (covering.has("*")) return [];
  return [...tools].filter((tool) => !covering.has(tool));
}

// Where an operator edits a grant. The server's map records what it resolved at
// boot, never which source each grant came from, so config.json is the only place
// doctor can name; the rest it can only place outside that file.
function editLocations(
  caller: string,
  target: string,
  inConfig: boolean,
  beyondConfig: boolean,
): string {
  const where: string[] = [];
  if (inConfig) where.push(`config.json (crossRibGrants.${caller}.${target})`);
  if (beyondConfig) where.push("whatever this server's grants came from beyond config.json");
  return where.length > 0 ? where.join(" and ") : "whatever this server's grants came from";
}

// Validate one caller -> target grant the server actually holds against the ribs
// actually active, then compare it to config.json to report what a restart would
// reproduce. Every finding is a warn: an inert or undurable grant is a
// misconfiguration, not corruption.
//
// `configTools` is undefined when config.json could not be read: what it declares
// is unknown, which is not the same as declaring nothing, so every config-relative
// claim below is suppressed rather than guessed.
function grantCheck(
  caller: string,
  target: string,
  serverTools: ReadonlySet<string>,
  configTools: ReadonlySet<string> | undefined,
  byId: ReadonlyMap<string, RibSummary>,
): CheckResult {
  const name = `grant ${caller} -> ${target}`;
  const declared = configTools ?? NO_TOOLS;

  // The server resolves grants once, at boot. A pair only config.json knows is
  // one the operator wrote since — denied by the running server until a restart.
  if (serverTools.size === 0) {
    return {
      name,
      status: "warn",
      detail: `config.json grants ${describeTools(declared, target)}, but the running server does not hold this grant; every call it covers is denied`,
      hint: "the server resolves grants at boot; restart it (`keelson stop && keelson start`) to apply config.json",
    };
  }

  // Both directions of the drift between the two maps. config.json is mutable
  // after boot, so a tool only the server holds proves only that config.json will
  // not reproduce it — never which source put it there.
  const beyondConfig = configTools ? notCoveredBy(serverTools, configTools) : [];
  const notYetApplied = configTools ? notCoveredBy(configTools, serverTools) : [];
  const where = editLocations(caller, target, declared.size > 0, beyondConfig.length > 0);
  const activeIds = [...byId.keys()];
  const active = activeIds.length > 0 ? quoteList(activeIds) : "none";

  if (!byId.has(caller)) {
    return {
      name,
      status: "warn",
      detail: `caller rib '${caller}' is not active; the grant is inert`,
      hint: `active ribs: ${active}. Correct the caller id in ${where}`,
    };
  }
  const targetRib = byId.get(target);
  if (!targetRib) {
    return {
      name,
      status: "warn",
      detail: `target rib '${target}' is not active; the grant is inert`,
      hint: `active ribs: ${active}. Correct the target id in ${where}`,
    };
  }
  if (targetRib.registered.length === 0) {
    return {
      name,
      status: "warn",
      detail: `rib '${target}' registers no tools; the grant is inert`,
      hint: `remove ${where}, or check that '${target}' is ready (a rib that fails to authenticate can register nothing)`,
    };
  }
  const registered = new Set(targetRib.registered);
  // A "*" in the grant reaches every tool the target owns, which subsumes any
  // name sitting beside it — none of those can be inert.
  const missing = serverTools.has("*")
    ? []
    : [...serverTools].filter((tool) => !registered.has(tool));
  // config.json's half of the drift is worth reporting from every branch below:
  // an operator who already fixed a tool name there needs to hear that the fix is
  // sitting unapplied, not just that the server's stale name is inert.
  const notes: string[] = [];
  const hints: string[] = [];
  if (notYetApplied.length > 0) {
    notes.push(`config.json grants ${quoteList(notYetApplied)}, which the server does not hold`);
    hints.push("restart the server (`keelson stop && keelson start`) to apply config.json");
  }

  if (missing.length > 0) {
    const plural = missing.length === 1 ? "" : "s";
    return {
      name,
      status: "warn",
      detail: [
        `rib '${target}' does not register ${quoteList(missing)}; ${missing.length === 1 ? "that grant is" : "those grants are"} inert`,
        ...notes,
      ].join("; "),
      hint: [
        `'${target}' registers ${quoteList(targetRib.registered)}. Fix the tool name${plural} in ${editLocations(
          caller,
          target,
          missing.some((tool) => declared.has(tool)),
          configTools !== undefined && missing.some((tool) => !declared.has(tool)),
        )}`,
        ...hints,
      ].join(". "),
    };
  }

  // Only one direction of durability is provable. Grants are a union, so a name
  // config.json carries is reproduced on every restart; a name it omits depends on
  // the environment the next server starts from, which doctor never sees. So this
  // can promise durability and must never promise revocation.
  const inForce = `${describeTools(serverTools, target)} in force`;
  if (beyondConfig.length > 0) {
    const it = beyondConfig.length === 1 ? "it" : "them";
    notes.push(
      `config.json does not name ${quoteList(beyondConfig)}, so a restart reproduces ${it} only if the server's environment supplies ${it} again`,
    );
    hints.push(
      `add ${quoteList(beyondConfig)} to config.json (crossRibGrants.${caller}.${target}) to hold ${it} independent of the environment`,
    );
  }
  if (notes.length > 0) {
    return {
      name,
      status: "warn",
      detail: `${inForce}; ${notes.join("; ")}`,
      hint: hints.join(". "),
    };
  }
  return { name, status: "ok", detail: configTools ? `${inForce} via config.json` : inForce };
}

// Every caller -> target pair either side knows about, server first.
function* grantPairs(
  server: CrossRibGrants,
  config: CrossRibGrants | undefined,
): Generator<[string, string], void> {
  const seen = new Set<string>();
  for (const [caller, targets] of server) {
    for (const target of targets.keys()) {
      seen.add(`${caller} ${target}`);
      yield [caller, target];
    }
  }
  for (const [caller, targets] of config ?? new Map<string, Map<string, Set<string>>>()) {
    for (const target of targets.keys()) {
      if (!seen.has(`${caller} ${target}`)) yield [caller, target];
    }
  }
}

// The server resolves its grants once, at boot (bootstrapRibs), so the map it
// reports is the only thing that answers "is this grant in force". Resolving
// config + env here instead would predict what a restarted server would hold, and
// silently pass the very drift this validates. config.json is read to catch the
// two ways the two can disagree, never to attribute a grant to a source.
function crossRibGrantChecks(
  ribs: readonly RibSummary[],
  reported: ListRibsResponse["crossRibGrants"],
  configRead: ReadKeelsonConfigResult,
): CheckResult[] {
  // A rejected config.json is degraded to {} everywhere else, which here would read
  // as "grants nothing" — the one answer doctor has no evidence for. It is reported
  // whatever the server says, since a file this broken is worth fixing either way.
  const rejected: CheckResult[] = configRead.ok
    ? []
    : [
        {
          name: "cross-rib grants",
          status: "warn",
          detail: `config.json was rejected (${configRead.reason}), so what it grants cannot be compared with what this server holds`,
          hint: `fix ${configRead.path}, then re-run doctor to validate cross-rib grants`,
        },
      ];
  if (!reported) {
    return [
      ...rejected,
      {
        name: "cross-rib grants",
        status: "skip",
        detail: "this server does not report the grants it enforces",
        hint: "upgrade the server (`keelson update`) to validate cross-rib grants",
      },
    ];
  }
  const serverGrants = crossRibGrantsFromConfig(reported);
  const checks: CheckResult[] = [...rejected];
  let configGrants: CrossRibGrants | undefined;
  if (configRead.ok) {
    configGrants = crossRibGrantsFromConfig(configRead.config.crossRibGrants);
    if (serverGrants.size === 0 && configGrants.size === 0) {
      return [
        { name: "cross-rib grants", status: "skip", detail: "no cross-rib grants configured" },
      ];
    }
  }
  const byId = new Map(ribs.map((rib) => [rib.id, rib]));
  for (const [caller, target] of grantPairs(serverGrants, configGrants)) {
    checks.push(
      grantCheck(
        caller,
        target,
        serverGrants.get(caller)?.get(target) ?? NO_TOOLS,
        configGrants ? (configGrants.get(caller)?.get(target) ?? NO_TOOLS) : undefined,
        byId,
      ),
    );
  }
  return checks;
}
