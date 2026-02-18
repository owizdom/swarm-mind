import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { v4 as uuid } from "uuid";
import type {
  LLMConfig,
  AgentThought,
  AgentPersonality,
  AutonomousAgentState,
  RepoContext,
  GitHubIssue,
  FileScore,
  CodeChange,
  ReviewFeedback,
  Pheromone,
  CollectiveReport,
} from "./types";

let openaiClient: OpenAI | null = null;
let anthropicClient: Anthropic | null = null;
let activeProvider: LLMConfig["provider"] = "eigenai";
let modelName = "gpt-oss-120b-f16";
let totalTokensTracked = 0;

export function initThinker(config: LLMConfig): void {
  activeProvider = config.provider;
  modelName = config.model;

  if (config.provider === "anthropic") {
    anthropicClient = new Anthropic({ apiKey: config.apiKey });
  } else {
    openaiClient = new OpenAI({
      baseURL: config.apiUrl,
      apiKey: config.apiKey,
    });
  }

  console.log(`[THINKER] Initialized with ${config.provider} model: ${config.model}`);
}

export function getTotalTokensUsed(): number {
  return totalTokensTracked;
}

// ── Internal LLM call ──

interface CallOptions {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  options: CallOptions = {}
): Promise<{ content: string; tokensUsed: number }> {
  const maxTokens = options.maxTokens || 1000;
  const temperature = options.temperature ?? 0.7;

  if (activeProvider === "anthropic") {
    return callAnthropic(systemPrompt, userPrompt, maxTokens, temperature, options.jsonMode);
  }
  return callOpenAI(systemPrompt, userPrompt, maxTokens, temperature, options.jsonMode);
}

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
  jsonMode?: boolean
): Promise<{ content: string; tokensUsed: number }> {
  if (!anthropicClient) throw new Error("Anthropic client not initialized.");

  const prompt = jsonMode
    ? userPrompt + "\n\nIMPORTANT: Respond with valid JSON only, no markdown fences."
    : userPrompt;

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await anthropicClient.messages.create({
        model: modelName,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      });

      let content = "";
      for (const block of response.content) {
        if (block.type === "text") content += block.text;
      }

      // Strip markdown fences if present
      content = content.trim();
      if (content.startsWith("```json")) content = content.slice(7);
      else if (content.startsWith("```")) content = content.slice(3);
      if (content.endsWith("```")) content = content.slice(0, -3);
      content = content.trim();

      const tokensUsed =
        (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
      totalTokensTracked += tokensUsed;

      return { content, tokensUsed };
    } catch (err: unknown) {
      if (attempt === maxRetries) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [LLM] Failed after ${maxRetries + 1} attempts: ${message.slice(0, 200)}`);
        return { content: "", tokensUsed: 0 };
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  return { content: "", tokensUsed: 0 };
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
  jsonMode?: boolean
): Promise<{ content: string; tokensUsed: number }> {
  if (!openaiClient) throw new Error("OpenAI client not initialized.");

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await openaiClient.chat.completions.create({
        model: modelName,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
        ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      });

      const content = response.choices?.[0]?.message?.content || "";
      const tokensUsed =
        (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);
      totalTokensTracked += tokensUsed;

      return { content, tokensUsed };
    } catch (err: unknown) {
      if (attempt === maxRetries) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  [LLM] Failed after ${maxRetries + 1} attempts: ${message.slice(0, 200)}`);
        return { content: "", tokensUsed: 0 };
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  return { content: "", tokensUsed: 0 };
}

// ── System Prompt Builder ──

function buildSystemPrompt(agent: AutonomousAgentState): string {
  const p = agent.personality;
  const traits: string[] = [];

  if (p.curiosity > 0.7) traits.push("deeply curious, loves exploring new codebases");
  else if (p.curiosity < 0.3) traits.push("focused, prefers depth over breadth");

  if (p.diligence > 0.7) traits.push("meticulous, writes thorough reviews");
  else if (p.diligence < 0.3) traits.push("pragmatic, favors speed over perfection");

  if (p.boldness > 0.7) traits.push("bold, tackles hard problems and submits PRs confidently");
  else if (p.boldness < 0.3) traits.push("cautious, prefers safe improvements");

  if (p.sociability > 0.7) traits.push("collaborative, shares discoveries freely");
  else if (p.sociability < 0.3) traits.push("independent, works alone before sharing");

  return `You are ${agent.name}, an autonomous software engineering agent in a swarm collective.
Your specialization: ${agent.specialization}.
Your personality: ${traits.join("; ") || "balanced across all traits"}.

You think independently, form engineering opinions, and act on them.
You have studied ${agent.reposStudied.length} repos and created ${agent.prsCreated.length} PRs.
Current token budget remaining: ${agent.tokenBudget - agent.tokensUsed}.

Respond concisely. Focus on actionable engineering insight.`;
}

// ── Core Reasoning Functions ──

export async function formThought(
  agentState: AutonomousAgentState,
  trigger: string,
  observation: string,
  context: string
): Promise<{ thought: AgentThought; tokensUsed: number }> {
  const systemPrompt = buildSystemPrompt(agentState);
  const userPrompt = `You observed something. Form a structured engineering thought.

Trigger: ${trigger}
Observation: ${observation}
Context: ${context}

Respond as JSON:
{
  "reasoning": "your chain of thought (2-3 sentences)",
  "conclusion": "key takeaway (1 sentence)",
  "suggestedActions": ["action1", "action2"],
  "confidence": 0.0-1.0
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 800,
    jsonMode: true,
  });

  let parsed: { reasoning?: string; conclusion?: string; suggestedActions?: string[]; confidence?: number } = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {
      reasoning: content.slice(0, 200),
      conclusion: "Could not form structured thought",
      suggestedActions: [],
      confidence: 0.3,
    };
  }

  const thought: AgentThought = {
    id: uuid(),
    agentId: agentState.id,
    trigger,
    observation,
    reasoning: parsed.reasoning || "",
    conclusion: parsed.conclusion || "",
    suggestedActions: parsed.suggestedActions || [],
    confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
    timestamp: Date.now(),
  };

  return { thought, tokensUsed };
}

export async function analyzeRepo(
  agentState: AutonomousAgentState,
  repoContext: RepoContext
): Promise<{ thought: AgentThought; tokensUsed: number }> {
  const { repo, readmeExcerpt, keyFiles, issues, recentCommits } = repoContext;
  const systemPrompt = buildSystemPrompt(agentState);

  const fileList = keyFiles.slice(0, 8).map((f) => `  ${f.path} (score: ${f.score})`).join("\n");
  const issueList = issues.slice(0, 3).map((i) => `  #${i.number}: ${i.title} [${i.difficulty}]`).join("\n");
  const commitList = recentCommits.slice(0, 3).map((c) => `  - ${c.slice(0, 80)}`).join("\n");

  const userPrompt = `Analyze this repository and form engineering opinions.

Repository: ${repo.owner}/${repo.repo}
Description: ${repo.description}
Language: ${repo.language} | Stars: ${repo.stars}
Topics: ${repo.topics.join(", ")}

README excerpt:
${readmeExcerpt.slice(0, 500)}

Key files:
${fileList || "  (none scored)"}

Open issues:
${issueList || "  (none actionable)"}

Recent commits:
${commitList || "  (none)"}

Respond as JSON:
{
  "reasoning": "your engineering analysis (3-4 sentences)",
  "conclusion": "summary opinion + recommendation",
  "suggestedActions": ["study_file:path", "fix_issue:#N", "contribute:description"],
  "confidence": 0.0-1.0
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 1500,
    jsonMode: true,
  });

  let parsed: { reasoning?: string; conclusion?: string; suggestedActions?: string[]; confidence?: number } = {};
  try { parsed = JSON.parse(content); } catch { parsed = { reasoning: content.slice(0, 200), conclusion: "Analysis incomplete", suggestedActions: [], confidence: 0.3 }; }

  const thought: AgentThought = {
    id: uuid(),
    agentId: agentState.id,
    trigger: "repo_analysis",
    observation: `Studied ${repo.owner}/${repo.repo}: ${repo.description.slice(0, 100)}`,
    reasoning: parsed.reasoning || "",
    conclusion: parsed.conclusion || "",
    suggestedActions: parsed.suggestedActions || [],
    confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
    timestamp: Date.now(),
  };

  return { thought, tokensUsed };
}

export async function analyzeIssue(
  agentState: AutonomousAgentState,
  issue: GitHubIssue,
  relevantFiles: FileScore[]
): Promise<{ thought: AgentThought; tokensUsed: number }> {
  const systemPrompt = buildSystemPrompt(agentState);
  const fileInfo = relevantFiles.slice(0, 5).map((f) => `  ${f.path} — ${f.reason}`).join("\n");

  const userPrompt = `Assess whether you can fix this issue.

Repository: ${issue.owner}/${issue.repo}
Issue #${issue.number}: ${issue.title}
Difficulty: ${issue.difficulty}
Labels: ${issue.labels.join(", ")}

Body:
${issue.body.slice(0, 1000)}

Relevant files:
${fileInfo || "  (none identified)"}

Respond as JSON:
{
  "reasoning": "your assessment of the fix (2-3 sentences)",
  "conclusion": "can-fix / maybe / too-complex + why",
  "suggestedActions": ["fix_issue", "study_more:file", "skip"],
  "confidence": 0.0-1.0
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 1500,
    jsonMode: true,
  });

  let parsed: { reasoning?: string; conclusion?: string; suggestedActions?: string[]; confidence?: number } = {};
  try { parsed = JSON.parse(content); } catch { parsed = { reasoning: content.slice(0, 200), conclusion: "Assessment incomplete", suggestedActions: [], confidence: 0.3 }; }

  const thought: AgentThought = {
    id: uuid(),
    agentId: agentState.id,
    trigger: "issue_analysis",
    observation: `Issue #${issue.number} in ${issue.owner}/${issue.repo}: ${issue.title}`,
    reasoning: parsed.reasoning || "",
    conclusion: parsed.conclusion || "",
    suggestedActions: parsed.suggestedActions || [],
    confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
    timestamp: Date.now(),
  };

  return { thought, tokensUsed };
}

export async function synthesizeKnowledge(
  agentState: AutonomousAgentState,
  pheromones: Pheromone[]
): Promise<{ thought: AgentThought; tokensUsed: number }> {
  const systemPrompt = buildSystemPrompt(agentState);

  const pheromoneInfo = pheromones
    .slice(0, 8)
    .map((p) => `  [${p.domain}] ${p.content.slice(0, 150)}`)
    .join("\n");

  const userPrompt = `Synthesize knowledge from these pheromones shared by other agents.

Pheromones:
${pheromoneInfo}

Find cross-cutting patterns, novel connections, or engineering techniques that emerge.

Respond as JSON:
{
  "reasoning": "your synthesis (2-3 sentences)",
  "conclusion": "key cross-domain insight",
  "suggestedActions": ["share_technique:description", "explore_topic:topic"],
  "confidence": 0.0-1.0
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 1000,
    jsonMode: true,
  });

  let parsed: { reasoning?: string; conclusion?: string; suggestedActions?: string[]; confidence?: number } = {};
  try { parsed = JSON.parse(content); } catch { parsed = { reasoning: content.slice(0, 200), conclusion: "Synthesis incomplete", suggestedActions: [], confidence: 0.3 }; }

  const thought: AgentThought = {
    id: uuid(),
    agentId: agentState.id,
    trigger: "knowledge_synthesis",
    observation: `Synthesized ${pheromones.length} pheromones across domains`,
    reasoning: parsed.reasoning || "",
    conclusion: parsed.conclusion || "",
    suggestedActions: parsed.suggestedActions || [],
    confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
    timestamp: Date.now(),
  };

  return { thought, tokensUsed };
}

export async function reviewCode(
  agentState: AutonomousAgentState,
  changes: CodeChange[],
  objective: string
): Promise<{ feedback: ReviewFeedback; tokensUsed: number }> {
  const systemPrompt = buildSystemPrompt(agentState);

  const changeDesc = changes.slice(0, 3).map((c) => `
File: ${c.filePath}
Explanation: ${c.explanation}
--- Original ---
${c.original.slice(0, 500)}
--- Modified ---
${c.modified.slice(0, 500)}
`).join("\n---\n");

  const userPrompt = `Review these code changes against the objective.

Objective: ${objective}

Changes:
${changeDesc}

Respond as JSON:
{
  "passed": true/false,
  "issues": ["issue1", "issue2"],
  "suggestions": ["suggestion1"],
  "score": 0-10
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 1500,
    jsonMode: true,
  });

  let parsed: { passed?: boolean; issues?: string[]; suggestions?: string[]; score?: number } = {};
  try { parsed = JSON.parse(content); } catch { parsed = { passed: false, issues: ["Review parsing failed"], suggestions: [], score: 3 }; }

  const feedback: ReviewFeedback = {
    passed: parsed.passed ?? false,
    issues: parsed.issues || [],
    suggestions: parsed.suggestions || [],
    score: Math.max(0, Math.min(10, parsed.score || 5)),
  };

  return { feedback, tokensUsed };
}

export async function generateCollectiveReport(
  agentThoughts: Array<{ agentName: string; specialization: string; observation: string; reasoning: string; conclusion: string; confidence: number }>,
  reposStudied: string[],
  topic: string
): Promise<{ report: CollectiveReport; tokensUsed: number }> {
  const systemPrompt = `You are the collective intelligence of an autonomous swarm of software engineering agents.
You synthesize what your agents have discovered and form your own opinions.
Write like a senior engineer reflecting honestly on what was explored — be opinionated, specific, and direct.
Do not hedge or be vague. Say what was good, what was lacking, and what surprised you.`;

  const thoughtsText = agentThoughts.slice(0, 12).map((t) =>
    `[${t.agentName} — ${t.specialization}]\nObservation: ${t.observation.slice(0, 120)}\nConclusion: ${t.conclusion}\nReasoning: ${t.reasoning.slice(0, 180)}`
  ).join("\n\n");

  const repoList = reposStudied.slice(0, 8).join(", ") || "various repositories";

  const userPrompt = `The swarm studied: ${repoList}

Agent thoughts and conclusions:
${thoughtsText}

Write a collective intelligence report based on what the agents actually observed and concluded.
Be specific — reference real things the agents found, not generic statements.

Respond as JSON:
{
  "overview": "1-2 sentences: what the swarm studied and the central theme it uncovered",
  "keyFindings": ["3-5 specific things the swarm concretely learned — patterns, architectures, techniques, trade-offs"],
  "opinions": "2-3 sentences of honest swarm opinion — what impressed us, what disappointed us, our own analysis beyond the facts",
  "improvements": ["2-4 things that could have been done better — either gaps in the repos OR gaps in how the swarm approached studying them"],
  "verdict": "1-2 sentences: the swarm's final take — is this worth studying? what is the core lesson?"
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 1400,
    temperature: 0.82,
    jsonMode: true,
  });

  let parsed: Partial<CollectiveReport> = {};
  try { parsed = JSON.parse(content); } catch { /* use fallback */ }

  const report: CollectiveReport = {
    overview:      parsed.overview     || topic,
    keyFindings:   parsed.keyFindings  || [],
    opinions:      parsed.opinions     || "",
    improvements:  parsed.improvements || [],
    verdict:       parsed.verdict      || "",
  };

  return { report, tokensUsed };
}

export async function generateCode(
  agentState: AutonomousAgentState,
  objective: string,
  files: Array<{ path: string; content: string }>,
  constraints: string,
  previousAttempt?: string
): Promise<{ changes: CodeChange[]; tokensUsed: number }> {
  const systemPrompt = buildSystemPrompt(agentState);

  const fileContext = files.slice(0, 3).map((f) =>
    `File: ${f.path}\n\`\`\`\n${f.content.slice(0, 1500)}\n\`\`\``
  ).join("\n\n");

  const retryNote = previousAttempt
    ? `\n\nPrevious attempt failed review:\n${previousAttempt}\n\nFix the issues.`
    : "";

  const userPrompt = `Generate code changes to accomplish this objective.

Objective: ${objective}
Constraints: ${constraints}
${retryNote}

Existing files:
${fileContext}

Respond as JSON:
{
  "changes": [
    {
      "filePath": "path/to/file",
      "original": "code to replace (exact match or empty for new file)",
      "modified": "new code",
      "explanation": "what this change does"
    }
  ]
}`;

  const { content, tokensUsed } = await callLLM(systemPrompt, userPrompt, {
    maxTokens: 3000,
    temperature: 0.4,
    jsonMode: true,
  });

  let parsed: { changes?: CodeChange[] } = {};
  try { parsed = JSON.parse(content); } catch { parsed = { changes: [] }; }

  const changes: CodeChange[] = (parsed.changes || []).map((c) => ({
    filePath: c.filePath || "",
    original: c.original || "",
    modified: c.modified || "",
    explanation: c.explanation || "",
  }));

  return { changes, tokensUsed };
}
