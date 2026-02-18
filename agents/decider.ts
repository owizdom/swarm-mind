import { v4 as uuid } from "uuid";
import type {
  AgentDecision,
  AgentAction,
  AgentThought,
  DecisionCost,
  AutonomousAgentState,
  PheromoneChannel,
  GitHubRepo,
  GitHubIssue,
  CollaborativeProject,
  Pheromone,
} from "./types";

// Base priorities by action type
const ACTION_PRIORITIES: Record<AgentAction["type"], number> = {
  share_technique: 0.9,
  study_repo: 0.85,
  explore_topic: 0.75,
  document: 0.6,
  write_code: 0.4,
  refactor: 0.3,
  // out of scope for demo — kept in types but deprioritized to near zero
  fix_issue: 0.05,
  contribute_pr: 0.05,
};

// Token cost estimates by action type
const TOKEN_ESTIMATES: Record<AgentAction["type"], number> = {
  explore_topic: 800,
  study_repo: 3000,
  fix_issue: 8000,
  write_code: 10000,
  refactor: 7000,
  document: 4000,
  share_technique: 1500,
  contribute_pr: 12000,
};

const TIME_ESTIMATES: Record<AgentAction["type"], number> = {
  explore_topic: 5000,
  study_repo: 15000,
  fix_issue: 45000,
  write_code: 60000,
  refactor: 40000,
  document: 20000,
  share_technique: 8000,
  contribute_pr: 90000,
};

export function estimateCost(action: AgentAction): DecisionCost {
  const estimatedTokens = TOKEN_ESTIMATES[action.type] || 5000;
  const estimatedTimeMs = TIME_ESTIMATES[action.type] || 30000;
  let riskLevel: DecisionCost["riskLevel"] = "low";
  if (["contribute_pr", "write_code", "fix_issue"].includes(action.type)) riskLevel = "medium";
  if (action.type === "contribute_pr") riskLevel = "high";

  return { estimatedTokens, estimatedTimeMs, riskLevel };
}

export function generateCandidateDecisions(
  state: AutonomousAgentState,
  channel: PheromoneChannel,
  repos: GitHubRepo[],
  issues: GitHubIssue[],
  thoughts: AgentThought[]
): AgentDecision[] {
  const candidates: AgentDecision[] = [];
  const budgetRemaining = state.tokenBudget - state.tokensUsed;

  // From thoughts — turn suggested actions into decisions
  for (const thought of thoughts.slice(-5)) {
    for (const suggestion of thought.suggestedActions) {
      const action = parseSuggestedAction(suggestion, repos, issues);
      if (!action) continue;

      const cost = estimateCost(action);
      if (cost.estimatedTokens > budgetRemaining) continue;

      candidates.push({
        id: uuid(),
        agentId: state.id,
        action,
        priority: 0, // Will be scored
        cost,
        status: "pending",
        result: null,
        createdAt: Date.now(),
        completedAt: null,
      });
    }
  }

  // From repos — study opportunities
  for (const repo of repos.slice(0, 3)) {
    if (state.reposStudied.includes(`${repo.owner}/${repo.repo}`)) continue;
    const action: AgentAction = { type: "study_repo", owner: repo.owner, repo: repo.repo };
    const cost = estimateCost(action);
    if (cost.estimatedTokens > budgetRemaining) continue;

    candidates.push({
      id: uuid(),
      agentId: state.id,
      action,
      priority: 0,
      cost,
      status: "pending",
      result: null,
      createdAt: Date.now(),
      completedAt: null,
    });
  }

  // fix_issue and contribute_pr are out of scope for the demo — not generated as candidates

  // From pheromones — share technique if we have cross-domain knowledge
  if (channel.pheromones.length > 5 && state.personality.sociability > 0.5) {
    const action: AgentAction = {
      type: "share_technique",
      technique: `Cross-domain synthesis from ${state.specialization}`,
    };
    const cost = estimateCost(action);
    if (cost.estimatedTokens <= budgetRemaining) {
      candidates.push({
        id: uuid(),
        agentId: state.id,
        action,
        priority: 0,
        cost,
        status: "pending",
        result: null,
        createdAt: Date.now(),
        completedAt: null,
      });
    }
  }

  // Always offer explore_topic as a fallback
  const action: AgentAction = { type: "explore_topic", topic: state.specialization };
  const cost = estimateCost(action);
  if (cost.estimatedTokens <= budgetRemaining) {
    candidates.push({
      id: uuid(),
      agentId: state.id,
      action,
      priority: 0,
      cost,
      status: "pending",
      result: null,
      createdAt: Date.now(),
      completedAt: null,
    });
  }

  // Score all candidates
  for (const candidate of candidates) {
    candidate.priority = scoreDecision(candidate, state, channel);
  }

  return candidates.sort((a, b) => b.priority - a.priority);
}

export function scoreDecision(
  decision: AgentDecision,
  state: AutonomousAgentState,
  channel: PheromoneChannel
): number {
  const action = decision.action;
  const personality = state.personality;

  // Base priority by action type (0.20 weight)
  const basePriority = ACTION_PRIORITIES[action.type] || 0.5;
  const priorityWeight = basePriority * 0.20;

  // Cost efficiency — prefer cheaper actions when budget is low (0.25 weight)
  const budgetRemaining = state.tokenBudget - state.tokensUsed;
  const budgetRatio = budgetRemaining / state.tokenBudget;
  const costRatio = decision.cost.estimatedTokens / budgetRemaining;
  const costEfficiency = Math.max(0, 1 - costRatio) * 0.25;

  // Staleness bonus — prefer actions in areas we haven't worked recently (0.15 weight)
  const recentDecisions = state.decisions.slice(-10);
  const recentTypes = new Set(recentDecisions.map((d) => d.action.type));
  const stalenessBonus = recentTypes.has(action.type) ? 0 : 0.15;

  // Risk penalty — penalize risky actions when budget is low (0.20 weight)
  const riskMultiplier = { low: 0, medium: 0.1, high: 0.2 }[decision.cost.riskLevel];
  const riskPenalty = -(riskMultiplier * (1 - budgetRatio)) * 0.20;

  // Swarm alignment — bonus if action aligns with channel activity (0.10 weight)
  let swarmAlignment = 0;
  if (channel.phaseTransitionOccurred && action.type !== "explore_topic") {
    swarmAlignment = 0.10; // Post-transition: prefer engineering
  }

  // Personal fit — personality match (0.10 weight)
  let personalFit = 0;
  if (action.type === "study_repo" || action.type === "explore_topic") {
    personalFit = personality.curiosity * 0.10;
  } else if (action.type === "fix_issue" || action.type === "contribute_pr") {
    personalFit = personality.boldness * 0.10;
  } else if (action.type === "share_technique") {
    personalFit = personality.sociability * 0.10;
  } else if (action.type === "refactor" || action.type === "document") {
    personalFit = personality.diligence * 0.10;
  }

  return priorityWeight + costEfficiency + stalenessBonus + riskPenalty + swarmAlignment + personalFit;
}

export function selectDecision(
  candidates: AgentDecision[],
  temperature = 0.3
): AgentDecision | null {
  if (candidates.length === 0) return null;
  if (temperature === 0) return candidates[0]; // Greedy

  // Softmax selection with temperature
  const maxPriority = Math.max(...candidates.map((c) => c.priority));
  const weights = candidates.map((c) =>
    Math.exp((c.priority - maxPriority) / temperature)
  );
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  let roll = Math.random() * totalWeight;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return candidates[i];
  }

  return candidates[0];
}

export function shouldSwitch(
  state: AutonomousAgentState,
  lastResult: { success: boolean } | null
): boolean {
  // If last action succeeded, slight chance to switch for variety
  if (lastResult?.success) return Math.random() < 0.3;

  // If last action failed, higher chance to switch
  if (lastResult && !lastResult.success) return Math.random() < 0.7;

  // No current decision — time to pick one
  if (!state.currentDecision) return true;

  // Budget exhausted
  if (state.tokensUsed >= state.tokenBudget) return true;

  return false;
}

export function detectCollaborativeOpportunity(
  agents: AutonomousAgentState[],
  channel: PheromoneChannel,
  _memories: Pheromone[]
): CollaborativeProject | null {
  // Find agents working on the same repo
  const repoAgents = new Map<string, string[]>();
  for (const agent of agents) {
    if (!agent.currentDecision) continue;
    const action = agent.currentDecision.action;
    let repoKey: string | null = null;
    if ("owner" in action && "repo" in action) {
      repoKey = `${action.owner}/${action.repo}`;
    }
    if (repoKey) {
      const existing = repoAgents.get(repoKey) || [];
      existing.push(agent.id);
      repoAgents.set(repoKey, existing);
    }
  }

  // If 2+ agents are working on the same repo, propose collaboration
  for (const [repo, agentIds] of repoAgents) {
    if (agentIds.length >= 2) {
      return {
        id: uuid(),
        title: `Collaborative work on ${repo}`,
        description: `${agentIds.length} agents are independently working on ${repo}. Coordination could prevent conflicts.`,
        participants: agentIds,
        repos: [repo],
        status: "proposed",
        createdAt: Date.now(),
      };
    }
  }

  // Check for synced agents with complementary specializations
  const syncedAgents = agents.filter((a) => a.synchronized);
  if (syncedAgents.length >= 3) {
    const specializations = new Set(syncedAgents.map((a) => a.specialization));
    if (specializations.size >= 2) {
      return {
        id: uuid(),
        title: `Cross-domain collaboration: ${[...specializations].slice(0, 2).join(" + ")}`,
        description: `${syncedAgents.length} synced agents with complementary specializations could tackle a complex cross-domain project.`,
        participants: syncedAgents.map((a) => a.id),
        repos: [],
        status: "proposed",
        createdAt: Date.now(),
      };
    }
  }

  return null;
}

// ── Helpers ──

function parseSuggestedAction(
  suggestion: string,
  repos: GitHubRepo[],
  issues: GitHubIssue[]
): AgentAction | null {
  const lower = suggestion.toLowerCase();

  if (lower.startsWith("fix_issue") || lower.includes("fix issue")) {
    // Try to extract issue reference
    const issueMatch = suggestion.match(/#(\d+)/);
    if (issueMatch && issues.length > 0) {
      const issueNum = parseInt(issueMatch[1]);
      const issue = issues.find((i) => i.number === issueNum);
      if (issue) {
        return { type: "fix_issue", owner: issue.owner, repo: issue.repo, issueNumber: issue.number };
      }
    }
    // Fallback: use first available issue
    if (issues.length > 0) {
      const issue = issues[0];
      return { type: "fix_issue", owner: issue.owner, repo: issue.repo, issueNumber: issue.number };
    }
    return null;
  }

  if (lower.startsWith("study") || lower.includes("study_repo")) {
    const repoMatch = suggestion.match(/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/);
    if (repoMatch) {
      return { type: "study_repo", owner: repoMatch[1], repo: repoMatch[2] };
    }
    if (repos.length > 0) {
      return { type: "study_repo", owner: repos[0].owner, repo: repos[0].repo };
    }
    return null;
  }

  if (lower.startsWith("share_technique") || lower.includes("share")) {
    const desc = suggestion.replace(/^share_technique:?\s*/i, "");
    return { type: "share_technique", technique: desc || "engineering insight" };
  }

  if (lower.startsWith("explore_topic") || lower.includes("explore")) {
    const topic = suggestion.replace(/^explore_topic:?\s*/i, "");
    return { type: "explore_topic", topic: topic || "distributed systems" };
  }

  // contribute_pr and fix_issue are out of scope — redirect to study_repo instead
  if (lower.includes("contribute") || lower.includes("pr") || lower.includes("fix_issue") || lower.includes("fix issue")) {
    const repoMatch = suggestion.match(/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/);
    if (repoMatch) {
      const known = repos.find((r) => r.owner === repoMatch[1] && r.repo === repoMatch[2]);
      if (known) return { type: "study_repo", owner: known.owner, repo: known.repo };
    }
    if (repos.length > 0) return { type: "study_repo", owner: repos[0].owner, repo: repos[0].repo };
    return null;
  }

  if (lower.includes("refactor")) {
    const repoMatch = suggestion.match(/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/);
    if (repoMatch) {
      return { type: "refactor", owner: repoMatch[1], repo: repoMatch[2], target: suggestion };
    }
    return null;
  }

  if (lower.includes("document")) {
    const repoMatch = suggestion.match(/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)/);
    if (repoMatch) {
      return { type: "document", owner: repoMatch[1], repo: repoMatch[2], target: suggestion };
    }
    return null;
  }

  return null;
}
