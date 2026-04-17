import { describe, it, expect, beforeEach, vi } from "vitest";
import { Command } from "commander";

const {
  mockAnalyzeReferenceVideo,
  mockGenerateBlueprint,
  mockCreateBuildPlan,
  mockLlmBuild,
  mockLlmJudgeCommand,
  mockRunJudge,
  mockRunAuto,
  mockCreateRevisionPlan,
} = vi.hoisted(() => ({
  mockAnalyzeReferenceVideo: vi.fn(),
  mockGenerateBlueprint: vi.fn(),
  mockCreateBuildPlan: vi.fn(),
  mockLlmBuild: vi.fn(),
  mockLlmJudgeCommand: vi.fn(),
  mockRunJudge: vi.fn(),
  mockRunAuto: vi.fn(),
  mockCreateRevisionPlan: vi.fn(),
}));

vi.mock("../../src/lib/launch-video/pipeline.js", () => ({
  analyzeReferenceVideo: (...args: unknown[]) => mockAnalyzeReferenceVideo(...args),
  createBuildPlan: (...args: unknown[]) => mockCreateBuildPlan(...args),
  createRevisionPlan: (...args: unknown[]) => mockCreateRevisionPlan(...args),
  generateBlueprint: (...args: unknown[]) => mockGenerateBlueprint(...args),
  llmBuild: (...args: unknown[]) => mockLlmBuild(...args),
  llmJudgeCommand: (...args: unknown[]) => mockLlmJudgeCommand(...args),
  runJudge: (...args: unknown[]) => mockRunJudge(...args),
  runAuto: (...args: unknown[]) => mockRunAuto(...args),
  summarizeAnalyzeResult: vi.fn().mockReturnValue("analyze-summary"),
  summarizeBlueprintResult: vi.fn().mockReturnValue("blueprint-summary"),
  summarizeBuildResult: vi.fn().mockReturnValue("build-summary"),
  summarizeJudgeResult: vi.fn().mockReturnValue("judge-summary"),
  summarizeReviseResult: vi.fn().mockReturnValue("revise-summary"),
}));

import { registerLaunchVideo } from "../../src/commands/launch-video.js";

describe("registerLaunchVideo", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerLaunchVideo(program);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockAnalyzeReferenceVideo.mockReset().mockResolvedValue({});
    mockGenerateBlueprint.mockReset().mockResolvedValue({});
    mockCreateBuildPlan.mockReset().mockResolvedValue({});
    mockLlmBuild.mockReset().mockResolvedValue({
      compositionPath: "/tmp/ai-composition.tsx",
      renderOutputPath: "/tmp/ai-preview.mp4",
      buildMetadataPath: "/tmp/ai-build.json",
    });
    mockLlmJudgeCommand.mockReset().mockResolvedValue({
      judge: {
        approved: true,
        summary: "solid",
        scores: {
          structure: 8,
          timing: 8,
          typography: 8,
          palette: 8,
          motion: 8,
          emotional_tone: 8,
        },
        top_fixes: [],
      },
    });
    mockRunJudge.mockReset().mockResolvedValue({});
    mockRunAuto.mockReset().mockResolvedValue({
      artifactPaths: { rootDir: "/tmp/bundle" },
      buildResult: { renderOutputPath: "/tmp/bundle/renders/ai-preview.mp4" },
      judgeResult: { judge: { approved: true } },
    });
    mockCreateRevisionPlan.mockReset().mockResolvedValue({});
  });

  it("runs analyze with the expected options", async () => {
    await program.parseAsync([
      "node",
      "test",
      "launch-video",
      "analyze",
      "--input",
      "/tmp/reference.mp4",
      "--project-name",
      "Demo",
    ]);

    expect(mockAnalyzeReferenceVideo).toHaveBeenCalledWith({
      force: undefined,
      inputPath: "/tmp/reference.mp4",
      outputRoot: "/Users/suraj.markupgmail.com/Desktop/video-hackathon-mvp",
      projectName: "Demo",
    });
  });

  it("supports blueprint, build, judge, and revise subcommands", async () => {
    await program.parseAsync([
      "node",
      "test",
      "launch-video",
      "blueprint",
      "--artifact-dir",
      "/tmp/bundle",
    ]);
    await program.parseAsync([
      "node",
      "test",
      "launch-video",
      "build",
      "--artifact-dir",
      "/tmp/bundle",
    ]);
    await program.parseAsync([
      "node",
      "test",
      "launch-video",
      "judge",
      "--artifact-dir",
      "/tmp/bundle",
    ]);
    await program.parseAsync([
      "node",
      "test",
      "launch-video",
      "revise",
      "--artifact-dir",
      "/tmp/bundle",
    ]);

    expect(mockGenerateBlueprint).toHaveBeenCalledTimes(1);
    expect(mockCreateBuildPlan).toHaveBeenCalledTimes(1);
    expect(mockRunJudge).toHaveBeenCalledTimes(1);
    expect(mockCreateRevisionPlan).toHaveBeenCalledTimes(1);
  });

  it("routes build and judge to the AI pipeline with --ai", async () => {
    await program.parseAsync([
      "node",
      "test",
      "launch-video",
      "build",
      "--artifact-dir",
      "/tmp/bundle",
      "--ai",
    ]);
    await program.parseAsync([
      "node",
      "test",
      "launch-video",
      "judge",
      "--artifact-dir",
      "/tmp/bundle",
      "--ai",
    ]);

    expect(mockLlmBuild).toHaveBeenCalledWith({
      artifactDir: "/tmp/bundle",
      force: undefined,
      inputPath: undefined,
      outputRoot: "/Users/suraj.markupgmail.com/Desktop/video-hackathon-mvp",
      projectName: "Launch Video MVP",
    });
    expect(mockCreateBuildPlan).not.toHaveBeenCalled();

    expect(mockLlmJudgeCommand).toHaveBeenCalledWith({
      artifactDir: "/tmp/bundle",
      force: undefined,
      inputPath: undefined,
      outputRoot: "/Users/suraj.markupgmail.com/Desktop/video-hackathon-mvp",
      projectName: "Launch Video MVP",
    });
    expect(mockRunJudge).not.toHaveBeenCalled();
  });

  it("supports the auto command", async () => {
    await program.parseAsync([
      "node",
      "test",
      "launch-video",
      "auto",
      "--input",
      "/tmp/reference.mp4",
      "--project-name",
      "Demo",
    ]);

    expect(mockRunAuto).toHaveBeenCalledWith({
      force: undefined,
      inputPath: "/tmp/reference.mp4",
      outputRoot: "/Users/suraj.markupgmail.com/Desktop/video-hackathon-mvp",
      projectName: "Demo",
    });
  });
});
