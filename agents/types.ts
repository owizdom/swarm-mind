import crypto from "crypto";

/** A single knowledge fragment discovered by an agent */
export interface Pheromone {
  id: string;
  agentId: string;
  content: string;           // The actual knowledge
  domain: string;            // What area this covers
  confidence: number;        // 0-1 how certain the agent is
  strength: number;          // Decays over time, boosted when others confirm
  connections: string[];     // IDs of related pheromones
  timestamp: number;
  attestation: string;       // SHA-256 hash for verification
}

/** What each agent knows and is doing */
export interface AgentState {
  id: string;
  name: string;
  position: { x: number; y: number };  // Abstract 2D exploration space
  velocity: { dx: number; dy: number };
  knowledge: Pheromone[];               // What this agent has discovered
  absorbed: Set<string>;                // Pheromone IDs it has picked up
  explorationTarget: string;            // Current focus area
  energy: number;                       // Activity level 0-1
  synchronized: boolean;               // Has it joined the collective?
  syncedWith: string[];                // Which agents it's synced with
  stepCount: number;
  discoveries: number;
  contributionsToCollective: number;
}

/** The shared pheromone channel — no central coordinator, just signals */
export interface PheromoneChannel {
  pheromones: Pheromone[];
  density: number;           // Current pheromone density (0-1)
  criticalThreshold: number; // When sync happens
  phaseTransitionOccurred: boolean;
  transitionStep: number | null;
}

/** LLM-written collective intelligence report */
export interface CollectiveReport {
  overview: string;          // What was studied and the main theme
  keyFindings: string[];     // Concrete things the swarm learned
  opinions: string;          // The swarm's own opinionated take
  improvements: string[];    // What could have been done better
  verdict: string;           // Final assessment / takeaway
}

/** Collective knowledge that emerges after phase transition */
export interface CollectiveMemory {
  id: string;
  topic: string;
  synthesis: string;         // Raw merged knowledge (fallback)
  contributors: string[];    // Which agents contributed
  pheromoneIds: string[];    // Which pheromones were combined
  confidence: number;        // Collective confidence
  attestation: string;       // Hash of the full synthesis
  createdAt: number;
  report?: CollectiveReport; // LLM-written narrative report
}

/** Full swarm state for dashboard */
export interface SwarmState {
  agents: AgentState[];
  channel: PheromoneChannel;
  collectiveMemories: CollectiveMemory[];
  step: number;
  startedAt: number;
  phaseTransitionOccurred: boolean;
  transitionStep: number | null;
  metrics: SwarmMetrics;
}

export interface SwarmMetrics {
  totalPheromones: number;
  totalDiscoveries: number;
  totalSyncs: number;
  avgEnergy: number;
  density: number;
  synchronizedCount: number;
  collectiveMemoryCount: number;
  uniqueDomainsExplored: number;
}

/** Attestation record for TEE verification */
export interface AttestationRecord {
  agentId: string;
  action: string;
  inputHash: string;
  outputHash: string;
  timestamp: number;
  teeSig: string;
}

// ── Engineering Types (v2) ──

/** LLM provider configuration */
export interface LLMConfig {
  provider: "eigenai" | "openai" | "anthropic";
  apiUrl: string;
  apiKey: string;
  model: string;
}

/** Agent personality traits (each 0-1) */
export interface AgentPersonality {
  curiosity: number;   // How eagerly it explores new repos/topics
  diligence: number;   // How thoroughly it reviews and tests
  boldness: number;    // Willingness to tackle hard issues / submit PRs
  sociability: number; // How much it cross-pollinates with other agents
}

/** A structured thought produced by LLM reasoning */
export interface AgentThought {
  id: string;
  agentId: string;
  trigger: string;         // What prompted this thought
  observation: string;     // What the agent noticed
  reasoning: string;       // Chain of thought
  conclusion: string;      // Final takeaway
  suggestedActions: string[]; // What should be done next
  confidence: number;      // 0-1
  timestamp: number;
}

/** Cost estimate for a decision */
export interface DecisionCost {
  estimatedTokens: number;
  estimatedTimeMs: number;
  riskLevel: "low" | "medium" | "high";
}

/** Result of executing a decision */
export interface DecisionResult {
  success: boolean;
  summary: string;
  artifacts: Artifact[];
  tokensUsed: number;
}

/** Discriminated union of possible agent actions */
export type AgentAction =
  | { type: "study_repo"; owner: string; repo: string; topic?: string }
  | { type: "fix_issue"; owner: string; repo: string; issueNumber: number }
  | { type: "write_code"; description: string; targetRepo?: string }
  | { type: "refactor"; owner: string; repo: string; target: string }
  | { type: "document"; owner: string; repo: string; target: string }
  | { type: "share_technique"; technique: string; sourceRepo?: string }
  | { type: "contribute_pr"; owner: string; repo: string; description: string }
  | { type: "explore_topic"; topic: string };

/** A decision an agent makes about what to do */
export interface AgentDecision {
  id: string;
  agentId: string;
  action: AgentAction;
  priority: number;       // Computed score
  cost: DecisionCost;
  status: "pending" | "executing" | "completed" | "failed";
  result: DecisionResult | null;
  createdAt: number;
  completedAt: number | null;
}

/** A GitHub repository discovered by an agent */
export interface GitHubRepo {
  owner: string;
  repo: string;
  description: string;
  language: string;
  stars: number;
  topics: string[];
  relevanceScore: number;
}

/** A GitHub issue that an agent might work on */
export interface GitHubIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  difficulty: "easy" | "medium" | "hard";
  relevanceScore: number;
}

/** Rich context built from analyzing a repository */
export interface RepoContext {
  repo: GitHubRepo;
  structure: string[];       // File tree paths
  readmeExcerpt: string;
  keyFiles: FileScore[];
  issues: GitHubIssue[];
  recentCommits: string[];
}

/** Scored file within a repo */
export interface FileScore {
  path: string;
  score: number;
  reason: string;
  keySnippets: string[];
}

/** Output artifact from agent execution */
export interface Artifact {
  type: "code_change" | "pr_url" | "analysis" | "technique";
  content: string;
  filePath?: string;
  prUrl?: string;
}

/** A code change produced by the executor */
export interface CodeChange {
  filePath: string;
  original: string;
  modified: string;
  explanation: string;
}

/** Multi-step execution plan */
export interface ExecutionPlan {
  steps: string[];
  status: "planning" | "implementing" | "reviewing" | "shipping" | "done" | "failed";
  iteration: number;
  maxIterations: number;
}

/** Feedback from self-review */
export interface ReviewFeedback {
  passed: boolean;
  issues: string[];
  suggestions: string[];
  score: number; // 0-10
}

/** Engineering-enhanced pheromone with code/PR artifacts */
export interface EngineeringPheromone extends Pheromone {
  pheromoneType: "knowledge" | "code" | "pr" | "technique";
  artifacts: Artifact[];
  githubRefs: string[];    // "owner/repo" strings
  codeSnippets: string[];
}

/** Extended agent state for autonomous engineering */
export interface AutonomousAgentState extends AgentState {
  thoughts: AgentThought[];
  decisions: AgentDecision[];
  currentDecision: AgentDecision | null;
  reposStudied: string[];     // "owner/repo" strings
  prsCreated: string[];       // PR URLs
  tokensUsed: number;
  tokenBudget: number;
  specialization: string;
  personality: AgentPersonality;
  currentAction: string;      // Human-readable label e.g. "studying repo", "fixing issue"
}

/** Collaborative project detected among agents */
export interface CollaborativeProject {
  id: string;
  title: string;
  description: string;
  participants: string[];     // Agent IDs
  repos: string[];            // "owner/repo" strings
  status: "proposed" | "active" | "completed";
  createdAt: number;
}

// ── Utility Functions ──

export function hash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function hashObject(obj: unknown): string {
  return hash(JSON.stringify(obj));
}
