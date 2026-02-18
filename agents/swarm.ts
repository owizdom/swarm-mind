import dotenv from "dotenv";
dotenv.config();

import {
  SwarmState,
  PheromoneChannel,
  CollectiveMemory,
  SwarmMetrics,
  Pheromone,
  LLMConfig,
  AgentThought,
  AgentDecision,
  CollaborativeProject,
  hash,
  hashObject,
} from "./types";
import { SwarmAgent } from "./agent";
import { startDashboard } from "../dashboard/server";
import { initThinker, getTotalTokensUsed, generateCollectiveReport } from "./thinker";
import { initDatabase, closeDatabase, saveAgent, getRecentThoughts, getRecentDecisions, getAllRepos } from "./persistence";
import { detectCollaborativeOpportunity } from "./decider";
import { v4 as uuid } from "uuid";

/**
 * EMERGENT SWARM MIND v2.0
 *
 * Autonomous Engineering Collective
 *
 * Agents explore the internet, discover GitHub repos, form independent
 * engineering thoughts, decide what to build/fix/contribute, and execute
 * actual code changes — all without central coordination.
 *
 * Progressive engagement: exploration → engineering.
 * Sandbox by default: all code changes are local until user approves.
 */

const SWARM_SIZE = parseInt(process.env.SWARM_SIZE || "6");
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_MS || "2000");
const ENGINEERING_STEP_INTERVAL = parseInt(process.env.ENGINEERING_STEP_INTERVAL_MS || "10000");
const PHEROMONE_DECAY = parseFloat(process.env.PHEROMONE_DECAY || "0.12");
const CRITICAL_DENSITY = parseFloat(process.env.CRITICAL_DENSITY || "0.55");
const MAX_STEPS = parseInt(process.env.MAX_STEPS || "0"); // 0 = infinite

// Global streams for dashboard
const globalThoughtStream: AgentThought[] = [];
const globalDecisionLog: AgentDecision[] = [];
const collaborativeProjects: CollaborativeProject[] = [];

function createChannel(): PheromoneChannel {
  return {
    pheromones: [],
    density: 0,
    criticalThreshold: CRITICAL_DENSITY,
    phaseTransitionOccurred: false,
    transitionStep: null,
  };
}

function computeDensity(channel: PheromoneChannel, agentCount: number): number {
  if (channel.pheromones.length === 0) return 0;

  const activePheromones = channel.pheromones.filter((p) => p.strength > 0.1);
  const avgStrength =
    activePheromones.reduce((s, p) => s + p.strength, 0) /
    Math.max(1, activePheromones.length);
  const totalConnections = activePheromones.reduce(
    (s, p) => s + p.connections.length,
    0
  );
  const connectivity =
    totalConnections / Math.max(1, activePheromones.length * agentCount);

  const raw =
    (activePheromones.length / (agentCount * 8)) *
    avgStrength *
    (1 + connectivity * 2);
  return Math.min(1.0, raw);
}

function decayPheromones(channel: PheromoneChannel): void {
  for (const p of channel.pheromones) {
    p.strength *= 1 - PHEROMONE_DECAY;
  }
  channel.pheromones = channel.pheromones.filter((p) => p.strength > 0.05);
}

async function synthesizeCollectiveMemory(
  agents: SwarmAgent[],
  channel: PheromoneChannel
): Promise<CollectiveMemory | null> {
  // With 3 agents, require at least 2 synced
  const syncedAgents = agents.filter((a) => a.state.synchronized);
  if (syncedAgents.length < 2) return null;

  // Only use pheromones with real analysis content — skip bare discovery stubs
  const richPheromones = channel.pheromones.filter(
    (p) => p.strength >= 0.3 && p.content.length > 40 && !p.content.startsWith("github:")
  );
  if (richPheromones.length < 2) return null;

  // Group by domain to find most active topic
  const domainGroups = new Map<string, Pheromone[]>();
  for (const p of richPheromones) {
    const existing = domainGroups.get(p.domain) || [];
    existing.push(p);
    domainGroups.set(p.domain, existing);
  }
  let bestDomain = "";
  let bestCount = 0;
  for (const [domain, ps] of domainGroups) {
    if (ps.length > bestCount) { bestDomain = domain; bestCount = ps.length; }
  }

  const domainPheromones = domainGroups.get(bestDomain) || richPheromones;
  const contributors = [...new Set(domainPheromones.map((p) => p.agentId))];
  if (contributors.length < 2) return null;

  // Derive topic
  const repoMentions = domainPheromones
    .map((p) => p.content.match(/Studied ([^\s:]+\/[^\s:]+)/)?.[1])
    .filter(Boolean).slice(0, 3) as string[];
  const topic = repoMentions.length > 0
    ? `Insights from ${repoMentions.join(", ")}`
    : bestDomain;

  // Build raw synthesis fallback
  const agentConclusions: string[] = [];
  for (const agent of syncedAgents) {
    const topThoughts = agent.state.thoughts
      .filter((t) => t.confidence > 0.5 && t.conclusion.length > 20)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 2);
    for (const t of topThoughts) {
      agentConclusions.push(`${agent.state.name}: ${t.conclusion}`);
    }
  }
  const pheromoneInsights = domainPheromones
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3).map((p) => p.content);
  const synthesis = [...agentConclusions, ...pheromoneInsights].filter(Boolean).slice(0, 6).join("\n\n");

  const avgConfidence =
    domainPheromones.reduce((s, p) => s + p.confidence, 0) / domainPheromones.length;

  // Gather all high-confidence thoughts across the whole swarm for the LLM report
  const allThoughts: Array<{ agentName: string; specialization: string; observation: string; reasoning: string; conclusion: string; confidence: number }> = [];
  for (const agent of agents) {
    for (const t of agent.state.thoughts) {
      if (t.confidence > 0.4 && t.conclusion.length > 20) {
        allThoughts.push({
          agentName: agent.state.name,
          specialization: agent.state.specialization,
          observation: t.observation,
          reasoning: t.reasoning,
          conclusion: t.conclusion,
          confidence: t.confidence,
        });
      }
    }
  }
  allThoughts.sort((a, b) => b.confidence - a.confidence);

  // All repos the swarm has studied so far
  const allRepos = [...new Set(agents.flatMap((a) => a.state.reposStudied))];

  // Generate LLM-written narrative report
  let report;
  try {
    const result = await generateCollectiveReport(allThoughts, allRepos, topic);
    report = result.report;
    console.log(`  [COLLECTIVE] Report generated (${result.tokensUsed} tokens)`);
  } catch {
    // LLM unavailable — proceed without report
  }

  const memory: CollectiveMemory = {
    id: uuid(),
    topic,
    synthesis,
    contributors,
    pheromoneIds: domainPheromones.map((p) => p.id),
    confidence: Math.min(1.0, avgConfidence + 0.1 * contributors.length),
    attestation: hash(synthesis + contributors.join(",") + Date.now()),
    createdAt: Date.now(),
    report,
  };

  for (const agent of agents) {
    if (contributors.includes(agent.state.id)) {
      agent.state.contributionsToCollective++;
    }
  }

  return memory;
}

function computeMetrics(
  agents: SwarmAgent[],
  channel: PheromoneChannel,
  memories: CollectiveMemory[]
): SwarmMetrics {
  const domains = new Set(channel.pheromones.map((p) => p.domain));
  return {
    totalPheromones: channel.pheromones.length,
    totalDiscoveries: agents.reduce((s, a) => s + a.state.discoveries, 0),
    totalSyncs: agents.filter((a) => a.state.synchronized).length,
    avgEnergy:
      agents.reduce((s, a) => s + a.state.energy, 0) / agents.length,
    density: channel.density,
    synchronizedCount: agents.filter((a) => a.state.synchronized).length,
    collectiveMemoryCount: memories.length,
    uniqueDomainsExplored: domains.size,
  };
}

function initLLM(): boolean {
  const provider = (process.env.LLM_PROVIDER || "eigenai") as LLMConfig["provider"];

  let config: LLMConfig;
  switch (provider) {
    case "openai":
      config = {
        provider: "openai",
        apiUrl: process.env.OPENAI_API_URL || "https://api.openai.com/v1",
        apiKey: process.env.OPENAI_API_KEY || "",
        model: process.env.OPENAI_MODEL || "gpt-4o",
      };
      break;
    case "anthropic":
      config = {
        provider: "anthropic",
        apiUrl: process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1",
        apiKey: process.env.ANTHROPIC_API_KEY || "",
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      };
      break;
    case "eigenai":
    default:
      config = {
        provider: "eigenai",
        apiUrl: process.env.EIGENAI_API_URL || "https://api.eigenai.xyz/v1",
        apiKey: process.env.EIGENAI_API_KEY || "",
        model: process.env.EIGENAI_MODEL || "gpt-oss-120b-f16",
      };
      break;
  }

  if (!config.apiKey || config.apiKey === "your_key") {
    console.log(`[LLM] No API key for ${provider} — engineering mode disabled`);
    return false;
  }

  try {
    initThinker(config);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[LLM] Failed to initialize: ${message}`);
    return false;
  }
}

let isShuttingDown = false;

async function main() {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║       EMERGENT SWARM MIND  v2.0.0                 ║");
  console.log("║  Autonomous Engineering Collective                ║");
  console.log("║  No leader. No coordinator. Just emergence.       ║");
  console.log("╚═══════════════════════════════════════════════════╝");
  console.log();

  // Initialize persistence
  try {
    initDatabase();
    console.log("[DB] SQLite initialized at ./swarm-mind.db");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[DB] Failed to initialize: ${message}`);
  }

  // Initialize LLM
  const llmReady = initLLM();

  // Create agents
  const agents: SwarmAgent[] = [];
  for (let i = 0; i < SWARM_SIZE; i++) {
    const agent = new SwarmAgent(i);
    if (llmReady) agent.enableEngineering();
    agents.push(agent);
  }

  const channel = createChannel();
  const collectiveMemories: CollectiveMemory[] = [];

  const swarmState: SwarmState = {
    agents: agents.map((a) => a.state),
    channel,
    collectiveMemories,
    step: 0,
    startedAt: Date.now(),
    phaseTransitionOccurred: false,
    transitionStep: null,
    metrics: computeMetrics(agents, channel, collectiveMemories),
  };

  // Start dashboard (with enhanced state)
  const port = parseInt(process.env.DASHBOARD_PORT || "3000");
  startDashboard(swarmState, agents, port, {
    globalThoughtStream,
    globalDecisionLog,
    collaborativeProjects,
  });

  const sandboxMode = process.env.SANDBOX_MODE !== "false";
  console.log(`Swarm size:          ${SWARM_SIZE} agents`);
  console.log(`Critical density:    ${CRITICAL_DENSITY}`);
  console.log(`Pheromone decay:     ${PHEROMONE_DECAY}`);
  console.log(`Sync interval:       ${SYNC_INTERVAL}ms`);
  console.log(`Engineering:         ${llmReady ? "ENABLED" : "DISABLED (no API key)"}`);
  console.log(`Sandbox mode:        ${sandboxMode ? "ON" : "OFF"}`);
  console.log(`Max steps:           ${MAX_STEPS === 0 ? "infinite" : MAX_STEPS}`);
  console.log(`Token budget/agent:  ${process.env.TOKEN_BUDGET_PER_AGENT || "50000"}`);
  console.log(`TEE mode:            ${process.env.MNEMONIC ? "YES" : "LOCAL"}`);
  console.log();
  console.log("Agents:");
  for (const a of agents) {
    console.log(
      `  ${a.state.name} [${a.state.specialization}] — exploring "${a.state.explorationTarget}"`
    );
  }
  console.log();
  console.log("Watching for phase transition...\n");

  // Graceful shutdown
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log("\n[SHUTDOWN] Persisting state...");
    try {
      for (const agent of agents) {
        saveAgent(agent.state);
      }
      closeDatabase();
      console.log("[SHUTDOWN] State saved. Goodbye.");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SHUTDOWN] Error: ${message}`);
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Main swarm loop
  for (let step = 0; MAX_STEPS === 0 || step < MAX_STEPS; step++) {
    if (isShuttingDown) break;
    swarmState.step = step;

    // Decay existing pheromones
    decayPheromones(channel);

    // Determine step interval (slower when engineering is active)
    const hasActiveEngineering = agents.some(
      (a) => a.state.currentDecision !== null
    );
    const stepInterval = hasActiveEngineering ? ENGINEERING_STEP_INTERVAL : SYNC_INTERVAL;

    // Each agent takes a step — parallel I/O with Promise.allSettled
    const stepResults = await Promise.allSettled(
      agents.map((agent) => agent.step(channel))
    );

    // Collect new pheromones
    const newPheromones: Pheromone[] = [];
    for (const result of stepResults) {
      if (result.status === "fulfilled" && result.value) {
        newPheromones.push(result.value);
      }
    }

    // Deposit new pheromones to channel
    channel.pheromones.push(...newPheromones);

    // Update density
    channel.density = computeDensity(channel, SWARM_SIZE);

    // Check for phase transition
    const syncCount = agents.filter((a) => a.state.synchronized).length;
    if (!channel.phaseTransitionOccurred && syncCount >= Math.ceil(SWARM_SIZE * 0.5)) {
      channel.phaseTransitionOccurred = true;
      channel.transitionStep = step;
      swarmState.phaseTransitionOccurred = true;
      swarmState.transitionStep = step;

      console.log("\n" + "█".repeat(60));
      console.log("█  PHASE TRANSITION — COLLECTIVE INTELLIGENCE EMERGED  █");
      console.log("█".repeat(60));
      console.log(`  Step:        ${step}`);
      console.log(`  Density:     ${channel.density.toFixed(3)}`);
      console.log(`  Synced:      ${syncCount}/${SWARM_SIZE}`);
      console.log(`  Pheromones:  ${channel.pheromones.length}`);
      console.log("█".repeat(60) + "\n");
    }

    // Synthesize collective memory post-transition
    if (channel.phaseTransitionOccurred && step % 3 === 0) {
      const memory = await synthesizeCollectiveMemory(agents, channel);
      if (memory) {
        collectiveMemories.push(memory);
        console.log(
          `  [COLLECTIVE] New shared memory: "${memory.topic}" (${memory.contributors.length} contributors, confidence ${memory.confidence.toFixed(2)})`
        );
      }
    }

    // Detect collaborative opportunities every 5 steps post-transition
    if (channel.phaseTransitionOccurred && step % 5 === 0) {
      const collab = detectCollaborativeOpportunity(
        agents.map((a) => a.state),
        channel,
        channel.pheromones
      );
      if (collab) {
        collaborativeProjects.push(collab);
        console.log(`  [COLLAB] Detected: ${collab.title}`);
      }
    }

    // Update global streams
    for (const agent of agents) {
      const newThoughts = agent.state.thoughts.slice(
        globalThoughtStream.filter((t) => t.agentId === agent.state.id).length
      );
      globalThoughtStream.push(...newThoughts);

      const newDecisions = agent.state.decisions.slice(
        globalDecisionLog.filter((d) => d.agentId === agent.state.id).length
      );
      globalDecisionLog.push(...newDecisions);
    }

    // Trim global streams to prevent memory bloat
    if (globalThoughtStream.length > 200) globalThoughtStream.splice(0, globalThoughtStream.length - 200);
    if (globalDecisionLog.length > 200) globalDecisionLog.splice(0, globalDecisionLog.length - 200);

    // Persist state every 10 steps
    if (step % 10 === 0 && step > 0) {
      try {
        for (const agent of agents) {
          saveAgent(agent.state);
        }
      } catch { /* DB may not be ready */ }
    }

    // Update swarm state
    swarmState.agents = agents.map((a) => ({
      ...a.state,
      absorbed: new Set(a.state.absorbed),
    }));
    swarmState.metrics = computeMetrics(agents, channel, collectiveMemories);

    // Enhanced status line
    const bar = "░".repeat(20).split("");
    const filled = Math.round(channel.density * 20);
    for (let i = 0; i < filled; i++) bar[i] = "█";
    const densityBar = bar.join("");

    const totalPRs = agents.reduce((s, a) => s + a.state.prsCreated.length, 0);
    const totalTokens = agents.reduce((s, a) => s + a.state.tokensUsed, 0);
    const activeActions = agents
      .filter((a) => a.state.currentDecision)
      .map((a) => `${a.state.name.split("-")[1]}:${a.state.currentAction?.split(" ")[0] || "?"}`)
      .join(",");

    const status = channel.phaseTransitionOccurred ? "SYNCED" : "exploring";
    console.log(
      `  [${String(step).padStart(3)}] density ${densityBar} ${channel.density.toFixed(3)} | ` +
        `pheromones ${String(channel.pheromones.length).padStart(3)} | ` +
        `synced ${syncCount}/${SWARM_SIZE} | ` +
        `discoveries ${agents.reduce((s, a) => s + a.state.discoveries, 0)} | ` +
        (totalPRs > 0 ? `PRs ${totalPRs} | ` : "") +
        (totalTokens > 0 ? `tokens ${totalTokens} | ` : "") +
        (activeActions ? `[${activeActions}] | ` : "") +
        `${status}`
    );

    // Wait
    await new Promise((r) => setTimeout(r, stepInterval));
  }

  // Final report (only if finite steps)
  if (MAX_STEPS > 0) {
    console.log("\n" + "=".repeat(60));
    console.log("SWARM COMPLETE");
    console.log("=".repeat(60));
    console.log(`  Total steps:             ${MAX_STEPS}`);
    console.log(`  Phase transition at:     step ${swarmState.transitionStep ?? "N/A"}`);
    console.log(`  Total pheromones:        ${channel.pheromones.length}`);
    console.log(`  Collective memories:     ${collectiveMemories.length}`);
    console.log(`  Total discoveries:       ${agents.reduce((s, a) => s + a.state.discoveries, 0)}`);
    console.log(`  Agents synchronized:     ${agents.filter((a) => a.state.synchronized).length}/${SWARM_SIZE}`);
    console.log(`  Total PRs created:       ${agents.reduce((s, a) => s + a.state.prsCreated.length, 0)}`);
    console.log(`  Total tokens used:       ${agents.reduce((s, a) => s + a.state.tokensUsed, 0)}`);
    console.log(`  Repos studied:           ${new Set(agents.flatMap((a) => a.state.reposStudied)).size}`);
    console.log(
      `  Attestation root:        ${hashObject(swarmState).slice(0, 32)}...`
    );

    await shutdown();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
