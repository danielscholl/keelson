// biome-ignore lint/suspicious/noTsIgnore: Bun provides this module at test runtime.
// @ts-ignore
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NodeHandler, type NodeResult, type RunSummary, runWorkflow } from "./executor.ts";
import { bashHandler } from "./handlers/bash.ts";
import { parseWorkflow } from "./loader.ts";
import type { DagNode, NodeOutput, WorkflowDefinition } from "./schema/index.ts";

const WORKFLOW_PATH = join(import.meta.dir, "../assets/workflows/design-converge.yaml");
const AGENT_IDS = [
  "propose-a",
  "propose-b",
  "propose-c",
  "critic-a",
  "critic-b",
  "critic-c",
  "verify",
  "synthesize",
] as const;
const MODEL_VENDORS = new Map([
  ["claude-opus-5", "anthropic"],
  ["claude-opus-4.8", "anthropic"],
  ["gpt-5.6-sol", "openai"],
  ["gpt-5.6-terra", "openai"],
  ["grok-4.6", "xai"],
]);

interface PanelFixture {
  root: string;
  brief: string;
  criteria: string;
  evidence: string;
  out: string;
  artifacts: string;
}

interface PanelRunOptions {
  runId?: string;
  outputs?: Readonly<Record<string, string>>;
  failed?: ReadonlySet<string>;
  routes?: Readonly<Record<string, { provider: string; model: string }>>;
  completedNodeOutputs?: ReadonlyMap<string, NodeOutput>;
  approvalFails?: boolean;
}

function loadWorkflow(): WorkflowDefinition {
  const parsed = parseWorkflow(readFileSync(WORKFLOW_PATH, "utf8"), WORKFLOW_PATH);
  if (parsed.error !== null || parsed.workflow === null) {
    throw new Error(parsed.error?.error ?? "design-converge did not parse");
  }
  return parsed.workflow;
}

function modelVendor(model: string | undefined): string {
  const vendor = model === undefined ? undefined : MODEL_VENDORS.get(model);
  if (vendor === undefined) throw new Error(`unknown design-converge model '${model ?? ""}'`);
  return vendor;
}

function makeFixture(): PanelFixture {
  const root = mkdtempSync(join(tmpdir(), "design-converge-"));
  const brief = join(root, "brief.md");
  const criteria = join(root, "criteria.md");
  const evidence = join(root, "evidence");
  const out = join(root, "out");
  const artifacts = join(root, "scratch");
  mkdirSync(evidence);
  mkdirSync(artifacts);
  writeFileSync(brief, "BRIEF-CONTENT\n");
  writeFileSync(criteria, "CRITERIA-CONTENT\n");
  writeFileSync(join(evidence, "facts.txt"), "EVIDENCE-CONTENT\n");
  return { root, brief, criteria, evidence, out, artifacts };
}

function effectiveRoute(
  node: DagNode,
  routes: PanelRunOptions["routes"],
): { provider: string; model: string } {
  return (
    routes?.[node.id] ?? {
      provider: "copilot",
      model: node.model_by_provider?.copilot ?? node.model ?? "deep",
    }
  );
}

async function runPanel(
  fixture: PanelFixture,
  options: PanelRunOptions = {},
): Promise<{
  summary: RunSummary;
  prompts: ReadonlyMap<string, string>;
}> {
  const prompts = new Map<string, string>();
  const promptHandler: NodeHandler = {
    type: "prompt",
    async handle(node, ctx): Promise<NodeResult> {
      prompts.set(node.id, ctx.resolvedBody);
      const output = options.outputs?.[node.id] ?? `OUTPUT:${node.id}`;
      const route = effectiveRoute(node, options.routes);
      if (options.failed?.has(node.id) === true) {
        return {
          status: "failed",
          output: { kind: "text", text: output },
          error: `${node.id} failed`,
          ...route,
        };
      }
      return {
        status: "succeeded",
        output: { kind: "text", text: output },
        ...route,
      };
    },
  };
  const approvalHandler: NodeHandler = {
    type: "approval",
    async handle(): Promise<NodeResult> {
      return options.approvalFails === true
        ? {
            status: "failed",
            output: { kind: "text", text: "" },
            error: "approval interrupted",
          }
        : { status: "succeeded", output: { kind: "text", text: "approved in test" } };
    },
  };
  const summary = await runWorkflow({
    workflow: loadWorkflow(),
    runId: options.runId ?? "design-test-run",
    inputs: {
      brief: fixture.brief,
      criteria: fixture.criteria,
      evidence: fixture.evidence,
      sources: fixture.root,
      out: fixture.out,
      round: "1",
    },
    handlers: new Map([
      ["bash", bashHandler],
      ["prompt", promptHandler],
      ["approval", approvalHandler],
    ]),
    cwd: fixture.root,
    artifactsDir: fixture.artifacts,
    ...(options.completedNodeOutputs !== undefined
      ? { completedNodeOutputs: options.completedNodeOutputs }
      : {}),
  });
  return { summary, prompts };
}

function completedResumeSeed(summary: RunSummary): Map<string, NodeOutput> {
  const alwaysRunIds = new Set(
    loadWorkflow()
      .nodes.filter((node) => node.always_run === true)
      .map((node) => node.id),
  );
  return new Map(
    Object.entries(summary.nodes).filter(
      ([id, output]) => output.state === "completed" && !alwaysRunIds.has(id),
    ),
  );
}

describe("design-converge", () => {
  test("pins Copilot and assigns every critic to the vendor of the omitted proposal", () => {
    const workflow = loadWorkflow();
    const proposalModels = new Map([
      ["propose-a", "claude-opus-5"],
      ["propose-b", "gpt-5.6-sol"],
      ["propose-c", "grok-4.6"],
    ]);
    const criticRoutes = [
      {
        id: "critic-a",
        model: "claude-opus-4.8",
        effort: "xhigh",
        omitted: "propose-a",
        inputs: ["propose-b", "propose-c"],
      },
      {
        id: "critic-b",
        model: "gpt-5.6-terra",
        effort: "xhigh",
        omitted: "propose-b",
        inputs: ["propose-a", "propose-c"],
      },
      {
        id: "critic-c",
        model: "grok-4.6",
        effort: "high",
        omitted: "propose-c",
        inputs: ["propose-a", "propose-b"],
      },
    ] as const;

    expect(workflow.provider).toBe("copilot");
    expect(workflow.provider_required).toBe(true);
    for (const [id, model] of proposalModels) {
      expect(workflow.nodes.find((node) => node.id === id)?.model_by_provider?.copilot).toBe(model);
    }
    for (const route of criticRoutes) {
      const critic = workflow.nodes.find((node) => node.id === route.id);
      expect(critic?.model_by_provider?.copilot).toBe(route.model);
      expect(critic?.effort).toBe(route.effort);
      expect(critic?.depends_on).toEqual(route.inputs);
      const criticVendor = modelVendor(route.model);
      expect(criticVendor).toBe(modelVendor(proposalModels.get(route.omitted)));
      for (const input of route.inputs) {
        expect(modelVendor(proposalModels.get(input))).not.toBe(criticVendor);
      }
    }
  });

  test("intake deterministically bundles content and protects a non-empty round", async () => {
    const fixture = makeFixture();
    try {
      const workflow = loadWorkflow();
      const intake = workflow.nodes.find((node) => node.id === "intake");
      expect(intake).toBeDefined();
      const intakeOnly = { ...workflow, nodes: [intake!] };
      const summary = await runWorkflow({
        workflow: intakeOnly,
        runId: "intake-ok",
        inputs: {
          brief: fixture.brief,
          criteria: fixture.criteria,
          evidence: fixture.evidence,
          out: fixture.out,
          round: "1",
        },
        handlers: new Map([["bash", bashHandler]]),
        cwd: fixture.root,
        artifactsDir: fixture.artifacts,
      });
      const output = summary.nodes.intake.output;
      expect(output).toContain("===== BRIEF =====\nBRIEF-CONTENT");
      expect(output).toContain("===== CRITERIA =====\nCRITERIA-CONTENT");
      expect(output).toContain("===== EVIDENCE: facts.txt =====\nEVIDENCE-CONTENT");
      expect(output).not.toContain(fixture.brief);
      expect(output).not.toContain(fixture.evidence);

      const reserved = await runWorkflow({
        workflow: intakeOnly,
        runId: "intake-contender",
        inputs: { brief: fixture.brief, out: fixture.out, round: "1" },
        handlers: new Map([["bash", bashHandler]]),
        cwd: fixture.root,
        artifactsDir: fixture.artifacts,
      });
      expect(reserved.nodes.intake.state).toBe("failed");
      expect(
        readFileSync(join(fixture.out, ".design-converge-round-1.reservation", "run-id"), "utf8"),
      ).toBe("intake-ok\n");

      const target = join(fixture.out, "round-2");
      mkdirSync(target, { recursive: true });
      const sentinel = join(target, "keep.txt");
      writeFileSync(sentinel, "prior run");
      const rejected = await runWorkflow({
        workflow: intakeOnly,
        runId: "intake-rejected",
        inputs: { brief: fixture.brief, out: fixture.out, round: "2" },
        handlers: new Map([["bash", bashHandler]]),
        cwd: fixture.root,
        artifactsDir: fixture.artifacts,
      });
      expect(rejected.nodes.intake.state).toBe("failed");
      expect(readFileSync(sentinel, "utf8")).toBe("prior run");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps agent intake deterministic, blind, and tools-only for verification", async () => {
    const fixture = makeFixture();
    try {
      const workflow = loadWorkflow();
      const promptNodes = workflow.nodes.filter((node) => node.prompt !== undefined);
      expect(
        promptNodes
          .filter((node) => (node.allowed_tools?.length ?? 0) > 0)
          .map((node) => [node.id, node.allowed_tools]),
      ).toEqual([["verify", ["Read", "Glob", "Grep"]]]);
      expect(
        promptNodes
          .filter((node) => node.id !== "verify")
          .every((node) => node.allowed_tools?.length === 0),
      ).toBe(true);
      const decide = workflow.nodes.at(-1);
      expect(decide?.id).toBe("decide");
      expect(decide?.approval?.capture_response).toBe(true);
      expect(decide?.approval?.message).toContain("preceding");
      expect(decide?.approval?.message).not.toContain("$");

      const { prompts } = await runPanel(fixture);
      for (const id of AGENT_IDS) {
        const prompt = prompts.get(id);
        expect(prompt).toContain("BRIEF-CONTENT");
        expect(prompt).toContain("CRITERIA-CONTENT");
        expect(prompt).toContain("EVIDENCE-CONTENT");
        expect(prompt).not.toContain("_OUTPUT_FILE");
        expect(prompt).not.toContain("claude-opus");
        expect(prompt).not.toContain("gpt-5.6");
        expect(prompt).not.toContain("grok-4.6");
      }
      expect(prompts.get("propose-a")).not.toContain("OUTPUT:propose-b");
      expect(prompts.get("propose-a")).not.toContain("OUTPUT:propose-c");
      expect(prompts.get("critic-a")).toContain("OUTPUT:propose-b");
      expect(prompts.get("critic-a")).toContain("OUTPUT:propose-c");
      expect(prompts.get("critic-a")).not.toContain("OUTPUT:propose-a");
      expect(prompts.get("critic-a")).not.toContain("OUTPUT:critic-b");
      expect(prompts.get("synthesize")).toContain("OUTPUT:verify");
      expect(prompts.get("synthesize")).toContain("OUTPUT:critic-a");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("persists the complete spill file when the capped output variable is truncated", async () => {
    const fixture = makeFixture();
    const longProposal = `HEAD\n${"x".repeat(64 * 1024)}\nTAIL`;
    try {
      const { summary } = await runPanel(fixture, {
        outputs: { "propose-a": longProposal },
      });
      expect(summary.nodes.persist.state).toBe("completed");
      expect(readFileSync(join(fixture.out, "round-1", "proposal-a.md"), "utf8")).toBe(
        longProposal,
      );
      expect(readFileSync(join(fixture.out, "round-1", "MANIFEST"), "utf8")).toContain(
        "run_id\tdesign-test-run",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("preserves failed output and replaces stale artifacts on resume", async () => {
    const fixture = makeFixture();
    try {
      const first = await runPanel(fixture, {
        runId: "resume-run",
        outputs: { "propose-b": "PARTIAL-B" },
        failed: new Set(["propose-b"]),
        approvalFails: true,
      });
      const target = join(fixture.out, "round-1");
      expect(first.summary.status).toBe("failed");
      expect(readFileSync(join(target, "proposal-b.md"), "utf8")).toBe("PARTIAL-B");
      expect(readFileSync(join(target, "MANIFEST"), "utf8")).toContain(
        "proposal-b.md\tpropose-b\tfailed",
      );
      writeFileSync(join(target, "stale.md"), "must disappear");

      const second = await runPanel(fixture, {
        runId: "resume-run",
        outputs: { "propose-b": "RECOVERED-B" },
        completedNodeOutputs: completedResumeSeed(first.summary),
      });
      expect(second.summary.status).toBe("succeeded");
      expect(readFileSync(join(target, "proposal-b.md"), "utf8")).toBe("RECOVERED-B");
      expect(() => readFileSync(join(target, "stale.md"), "utf8")).toThrow();
      expect(second.prompts.has("propose-a")).toBe(false);
      expect(second.prompts.has("propose-b")).toBe(true);
      expect(second.prompts.has("critic-a")).toBe(true);
      expect(second.prompts.has("synthesize")).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("fails completion when every proposal fails", async () => {
    const fixture = makeFixture();
    try {
      const { summary } = await runPanel(fixture, {
        failed: new Set(["propose-a", "propose-b", "propose-c"]),
      });
      expect(summary.status).toBe("failed");
      expect(summary.nodes.synthesize.state).toBe("skipped");
      expect(summary.nodes.persist.state).toBe("completed");
      expect(summary.nodes.complete.state).toBe("failed");
      expect(summary.nodes.decide.state).toBe("skipped");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("reports collapse from effective routes rather than intended model pins", async () => {
    const collapsedFixture = makeFixture();
    const diverseFixture = makeFixture();
    const partialFixture = makeFixture();
    const collapsedRoutes = Object.fromEntries(
      AGENT_IDS.map((id) => [id, { provider: "claude", model: "claude-fable-5" }]),
    );
    const diverseRoutes = {
      "propose-a": { provider: "copilot", model: "claude-opus-5" },
      "propose-b": { provider: "copilot", model: "gpt-5.6-sol" },
      "propose-c": { provider: "copilot", model: "grok-4.6" },
      "critic-a": { provider: "copilot", model: "claude-opus-4.8" },
      "critic-b": { provider: "copilot", model: "gpt-5.6-terra" },
      "critic-c": { provider: "copilot", model: "grok-4.6" },
      verify: { provider: "copilot", model: "gpt-5.6-terra" },
      synthesize: { provider: "copilot", model: "claude-opus-4.8" },
    };
    try {
      const collapsed = await runPanel(collapsedFixture, { routes: collapsedRoutes });
      expect(collapsed.summary.nodes.complete.output).toContain(
        "WARNING: effective routing collapsed proposer vendor diversity to 1/3",
      );
      expect(collapsed.summary.nodes.complete.output).toContain(
        "WARNING: effective routing collapsed critic vendor diversity to 1/3",
      );
      expect(collapsed.summary.nodes.complete.output).toContain("propose-a=claude/claude-fable-5");

      const diverse = await runPanel(diverseFixture, { routes: diverseRoutes });
      expect(diverse.summary.nodes.complete.output).not.toContain("effective routing collapsed");

      const partial = await runPanel(partialFixture, {
        failed: new Set(["propose-b", "propose-c"]),
        routes: diverseRoutes,
      });
      expect(partial.summary.nodes["critic-a"].state).toBe("skipped");
      expect(partial.summary.nodes["critic-b"].state).toBe("completed");
      expect(partial.summary.nodes["critic-c"].state).toBe("completed");
      expect(partial.summary.nodes.complete.output).toContain(
        "WARNING: effective routing collapsed critic vendor diversity to 2/3",
      );
    } finally {
      rmSync(collapsedFixture.root, { recursive: true, force: true });
      rmSync(diverseFixture.root, { recursive: true, force: true });
      rmSync(partialFixture.root, { recursive: true, force: true });
    }
  }, 30_000);
});
