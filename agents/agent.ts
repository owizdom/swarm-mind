import { v4 as uuid } from "uuid";
import {
  AgentState,
  Pheromone,
  PheromoneChannel,
  AutonomousAgentState,
  AgentPersonality,
  AgentThought,
  AgentDecision,
  EngineeringPheromone,
  GitHubRepo,
  GitHubIssue,
  hash,
} from "./types";
import { discoverRepos, getTrendingRepos, getActionableIssues } from "./github";
import { formThought, synthesizeKnowledge } from "./thinker";
import {
  generateCandidateDecisions,
  selectDecision,
  shouldSwitch,
} from "./decider";
import { executeDecision } from "./executor";
import { saveThought, saveDecision, updateDecisionStatus } from "./persistence";

/**
 * Individual Swarm Agent — runs in its own TEE.
 *
 * v2: Agents autonomously browse GitHub, study repos, form engineering
 * thoughts, decide what to build/fix/contribute, and execute code changes.
 *
 * Progressive engagement: starts with exploration (v1), ramps into
 * engineering mode as knowledge builds.
 */

const DOMAINS = [
  "data structures and algorithms",
  "distributed systems architecture",
  "cryptographic primitives",
  "network protocols and security",
  "database optimization patterns",
  "compiler design techniques",
  "operating system internals",
  "machine learning optimization",
  "consensus mechanisms",
  "memory management strategies",
];

const NAMES = ["Neuron-A", "Neuron-B", "Neuron-C"];

// Personality presets
const PERSONALITY_PRESETS: Array<{ name: string; personality: AgentPersonality }> = [
  { name: "Explorer",    personality: { curiosity: 0.9, diligence: 0.4, boldness: 0.3, sociability: 0.6 } },
  { name: "Synthesizer", personality: { curiosity: 0.7, diligence: 0.5, boldness: 0.4, sociability: 0.9 } },
  { name: "Builder",     personality: { curiosity: 0.5, diligence: 0.6, boldness: 0.9, sociability: 0.3 } },
];

function generatePersonality(index: number): { specialization: string; personality: AgentPersonality } {
  const preset = PERSONALITY_PRESETS[index % PERSONALITY_PRESETS.length];
  // Add slight random perturbation for uniqueness
  const perturb = () => Math.max(0, Math.min(1, (Math.random() - 0.5) * 0.1));
  return {
    specialization: preset.name,
    personality: {
      curiosity: Math.max(0, Math.min(1, preset.personality.curiosity + perturb())),
      diligence: Math.max(0, Math.min(1, preset.personality.diligence + perturb())),
      boldness: Math.max(0, Math.min(1, preset.personality.boldness + perturb())),
      sociability: Math.max(0, Math.min(1, preset.personality.sociability + perturb())),
    },
  };
}

export class SwarmAgent {
  state: AutonomousAgentState;
  private discoveredRepos: GitHubRepo[] = [];
  private discoveredIssues: GitHubIssue[] = [];
  private engineeringEnabled: boolean = false;

  constructor(index: number) {
    const angle = (index / 8) * Math.PI * 2;
    const radius = 300 + Math.random() * 200;
    const { specialization, personality } = generatePersonality(index);
    const tokenBudget = parseInt(process.env.TOKEN_BUDGET_PER_AGENT || "50000");

    this.state = {
      // Base AgentState
      id: uuid(),
      name: NAMES[index] || `Neuron-${index}`,
      position: {
        x: 500 + Math.cos(angle) * radius,
        y: 400 + Math.sin(angle) * radius,
      },
      velocity: {
        dx: (Math.random() - 0.5) * 8,
        dy: (Math.random() - 0.5) * 8,
      },
      knowledge: [],
      absorbed: new Set(),
      explorationTarget: DOMAINS[index % DOMAINS.length],
      energy: 0.3 + Math.random() * 0.3,
      synchronized: false,
      syncedWith: [],
      stepCount: 0,
      discoveries: 0,
      contributionsToCollective: 0,

      // AutonomousAgentState extensions
      thoughts: [],
      decisions: [],
      currentDecision: null,
      reposStudied: [],
      prsCreated: [],
      tokensUsed: 0,
      tokenBudget,
      specialization,
      personality,
      currentAction: "initializing",
    };
  }

  enableEngineering(): void {
    this.engineeringEnabled = true;
  }

  /** Determine if this step should be engineering vs exploration */
  private shouldDoEngineering(): boolean {
    if (!this.engineeringEnabled) return false;
    if (this.state.tokensUsed >= this.state.tokenBudget) return false;

    // Ramp: 0% at step 0, ~20% at step 5, ~50% at step 20, ~80% at step 40
    const step = this.state.stepCount;
    const probability = Math.min(0.8, step / 50);
    return Math.random() < probability;
  }

  /** One exploration step */
  async step(channel: PheromoneChannel): Promise<Pheromone | null> {
    this.state.stepCount++;

    // 1. Move through exploration space
    this.move(channel);

    // 2. Absorb nearby pheromones from other agents
    const absorbed = this.absorbPheromones(channel);

    // 3. Branch: engineering mode or exploration mode
    let discovery: Pheromone | null = null;

    if (this.shouldDoEngineering()) {
      // Continue multi-step execution if we have an active decision
      if (this.state.currentDecision && this.state.currentDecision.status === "executing") {
        discovery = await this.continueExecution(absorbed);
      } else {
        discovery = await this.engineeringStep(channel, absorbed);
      }
    } else {
      // Classic exploration mode
      discovery = await this.explore(absorbed);
    }

    // 4. Check for synchronization
    this.checkSync(channel);

    return discovery;
  }

  /** Engineering step: think → decide → execute → emit pheromone */
  private async engineeringStep(
    channel: PheromoneChannel,
    absorbed: Pheromone[]
  ): Promise<Pheromone | null> {
    this.state.currentAction = "thinking";

    try {
      // Think about what we've observed
      let thought: AgentThought | null = null;

      if (absorbed.length > 0 && this.state.personality.sociability > 0.4) {
        // Cross-pollinate from absorbed pheromones
        const { thought: synthThought, tokensUsed } = await synthesizeKnowledge(
          this.state,
          absorbed
        );
        thought = synthThought;
        this.state.tokensUsed += tokensUsed;
      } else {
        // Form independent thought about what to explore/build
        const trigger = this.discoveredRepos.length > 0 ? "repo_analysis" : "exploration";
        const observation = this.discoveredRepos.length > 0
          ? `Have studied ${this.state.reposStudied.length} repos. Discovered ${this.discoveredIssues.length} issues.`
          : `Step ${this.state.stepCount}, exploring ${this.state.explorationTarget}`;

        const { thought: formThoughtResult, tokensUsed } = await formThought(
          this.state,
          trigger,
          observation,
          `Specialization: ${this.state.specialization}, energy: ${this.state.energy.toFixed(2)}`
        );
        thought = formThoughtResult;
        this.state.tokensUsed += tokensUsed;
      }

      if (thought) {
        this.state.thoughts.push(thought);
        try { saveThought(thought); } catch { /* DB not ready yet */ }
      }

      // Discover repos if we don't have many
      if (this.discoveredRepos.length < 5 && Math.random() < this.state.personality.curiosity) {
        const discoveryTopics = (process.env.GITHUB_DISCOVERY_TOPICS || "typescript,rust,ai").split(",");
        const topic = discoveryTopics[Math.floor(Math.random() * discoveryTopics.length)];
        const newRepos = discoverRepos(topic, { limit: 5, minStars: 10 });
        this.discoveredRepos.push(...newRepos);

        // Also check for trending repos
        if (Math.random() < 0.3) {
          const trending = getTrendingRepos(topic, 7);
          this.discoveredRepos.push(...trending);
        }
      }

      // Collect issues from studied repos
      if (this.discoveredIssues.length < 5 && this.discoveredRepos.length > 0) {
        const repo = this.discoveredRepos[Math.floor(Math.random() * this.discoveredRepos.length)];
        const issues = getActionableIssues(repo.owner, repo.repo, 5);
        this.discoveredIssues.push(...issues);
      }

      // Generate and select a decision
      this.state.currentAction = "deciding";
      const candidates = generateCandidateDecisions(
        this.state,
        channel,
        this.discoveredRepos,
        this.discoveredIssues,
        this.state.thoughts.slice(-10)
      );

      const decision = selectDecision(candidates, 0.3);
      if (!decision) {
        this.state.currentAction = "idle (no candidates)";
        return null;
      }

      // Execute the decision
      this.state.currentDecision = decision;
      decision.status = "executing";
      try { saveDecision(decision); } catch { /* DB not ready yet */ }

      const result = await executeDecision(this.state, decision);

      decision.status = result.success ? "completed" : "failed";
      decision.result = result;
      decision.completedAt = Date.now();
      this.state.decisions.push(decision);
      this.state.currentDecision = null;

      try {
        updateDecisionStatus(decision.id, decision.status, result);
      } catch { /* DB not ready yet */ }

      console.log(
        `  [${this.state.name}] ${decision.action.type}: ${result.summary.slice(0, 80)}`
      );

      // Create engineering pheromone from the result
      if (result.success && result.artifacts.length > 0) {
        return this.createEngineeringPheromone(decision, result);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [${this.state.name}] Engineering error: ${message.slice(0, 100)}`);
      this.state.currentAction = "recovering from error";
    }

    return null;
  }

  /** Continue an in-progress multi-step decision */
  private async continueExecution(absorbed: Pheromone[]): Promise<Pheromone | null> {
    const decision = this.state.currentDecision;
    if (!decision) return null;

    // Check if we should switch to a different task
    const lastResult = decision.result;
    if (shouldSwitch(this.state, lastResult)) {
      decision.status = "completed";
      decision.completedAt = Date.now();
      this.state.decisions.push(decision);
      this.state.currentDecision = null;
      return null;
    }

    // Continue executing
    const result = await executeDecision(this.state, decision);
    decision.result = result;

    if (result.success || decision.status !== "executing") {
      decision.status = result.success ? "completed" : "failed";
      decision.completedAt = Date.now();
      this.state.decisions.push(decision);
      this.state.currentDecision = null;

      if (result.success && result.artifacts.length > 0) {
        return this.createEngineeringPheromone(decision, result);
      }
    }

    return null;
  }

  /** Create an engineering-enhanced pheromone from a decision result */
  private createEngineeringPheromone(
    decision: AgentDecision,
    result: { summary: string; artifacts: Array<{ type: string; content: string; prUrl?: string }> }
  ): EngineeringPheromone {
    const hasCode = result.artifacts.some((a) => a.type === "code_change");
    const hasPR = result.artifacts.some((a) => a.type === "pr_url");

    const pheromoneType = hasPR ? "pr" : hasCode ? "code" : result.artifacts.some((a) => a.type === "technique") ? "technique" : "knowledge";

    const githubRefs: string[] = [];
    const action = decision.action;
    if ("owner" in action && "repo" in action) {
      githubRefs.push(`${action.owner}/${action.repo}`);
    }

    const pheromone: EngineeringPheromone = {
      id: uuid(),
      agentId: this.state.id,
      content: result.summary,
      domain: this.state.explorationTarget,
      confidence: decision.priority,
      strength: 0.6 + decision.priority * 0.3,
      connections: [],
      timestamp: Date.now(),
      attestation: hash(result.summary + this.state.id + Date.now()),
      pheromoneType,
      artifacts: result.artifacts.map((a) => ({
        type: a.type as "code_change" | "pr_url" | "analysis" | "technique",
        content: a.content,
        prUrl: a.prUrl,
      })),
      githubRefs,
      codeSnippets: result.artifacts
        .filter((a) => a.type === "code_change")
        .map((a) => a.content.slice(0, 200)),
    };

    this.state.knowledge.push(pheromone);
    this.state.discoveries++;

    return pheromone;
  }

  /** Move through the abstract exploration space */
  private move(channel: PheromoneChannel): void {
    if (this.state.synchronized) {
      // Pull toward collective center
      const cx = 500, cy = 400;
      const pullStrength = 0.05;
      this.state.velocity.dx += (cx - this.state.position.x) * pullStrength;
      this.state.velocity.dy += (cy - this.state.position.y) * pullStrength;
      // Orbit
      this.state.velocity.dx += (this.state.position.y - cy) * 0.01;
      this.state.velocity.dy += -(this.state.position.x - cx) * 0.01;
    } else {
      // Brownian motion + pheromone attraction
      this.state.velocity.dx += (Math.random() - 0.5) * 4;
      this.state.velocity.dy += (Math.random() - 0.5) * 4;

      // Attracted to strong pheromones from others
      for (const p of channel.pheromones) {
        if (p.agentId === this.state.id) continue;
        if (this.state.absorbed.has(p.id)) continue;
        if (p.strength > 0.5) {
          this.state.velocity.dx += (Math.random() - 0.5) * p.strength * 3;
          this.state.velocity.dy += (Math.random() - 0.5) * p.strength * 3;
        }
      }
    }

    // Damping
    this.state.velocity.dx *= 0.85;
    this.state.velocity.dy *= 0.85;

    // Apply
    this.state.position.x += this.state.velocity.dx;
    this.state.position.y += this.state.velocity.dy;

    // Soft bounds
    this.state.position.x = Math.max(50, Math.min(950, this.state.position.x));
    this.state.position.y = Math.max(50, Math.min(750, this.state.position.y));
  }

  /** Pick up pheromones from the shared channel */
  private absorbPheromones(channel: PheromoneChannel): Pheromone[] {
    const absorbed: Pheromone[] = [];

    for (const p of channel.pheromones) {
      if (p.agentId === this.state.id) continue;
      if (this.state.absorbed.has(p.id)) continue;

      if (p.strength > 0.2 && Math.random() < p.strength * 0.6) {
        this.state.absorbed.add(p.id);
        absorbed.push(p);
        this.state.energy = Math.min(1.0, this.state.energy + 0.05);

        // Boost the original pheromone (positive feedback)
        p.strength = Math.min(1.0, p.strength + 0.1);
      }
    }

    return absorbed;
  }

  /** Explore — discover GitHub repos and emit knowledge pheromones */
  private async explore(absorbed: Pheromone[]): Promise<Pheromone | null> {
    this.state.currentAction = "exploring github";
    const discoveryChance = this.state.synchronized ? 0.7 : 0.4;
    if (Math.random() > discoveryChance) return null;

    let content: string;
    let domain = this.state.explorationTarget;
    let connections: string[] = [];
    let confidence: number = 0.4;

    if (absorbed.length > 0 && Math.random() < 0.6) {
      // CROSS-POLLINATION: search GitHub for repos related to absorbed pheromone
      const source = absorbed[Math.floor(Math.random() * absorbed.length)];
      connections = [source.id];
      confidence = Math.min(1.0, source.confidence + 0.1);
      domain = source.domain;

      const keywords = source.content.split(/\s+/).filter((w) => w.length > 4).slice(0, 3);
      const searchTerm = keywords.join(" ") || this.state.explorationTarget;
      const repos = discoverRepos(searchTerm, { limit: 3 });

      if (repos.length > 0) {
        const repo = repos[0];
        if (!this.discoveredRepos.some((r) => r.owner === repo.owner && r.repo === repo.repo)) {
          this.discoveredRepos.push(repo);
        }
        content = `github:${repo.owner}/${repo.repo} — ${repo.description}`;
        console.log(`    ${this.state.name} github bridge: ${repo.owner}/${repo.repo}`);
      } else {
        content = this.fallbackInsight(source);
      }

      if (source.strength > 0.6) {
        this.state.explorationTarget = source.domain;
      }
    } else {
      // INDEPENDENT DISCOVERY via GitHub topics
      const discoveryTopics = (process.env.GITHUB_DISCOVERY_TOPICS || "typescript,rust,ai").split(",");
      const topic = discoveryTopics[Math.floor(Math.random() * discoveryTopics.length)];
      const repos = discoverRepos(topic, { limit: 5, minStars: 10 });

      confidence = 0.4 + Math.random() * 0.4;

      if (repos.length > 0) {
        const repo = repos[Math.floor(Math.random() * repos.length)];
        if (!this.discoveredRepos.some((r) => r.owner === repo.owner && r.repo === repo.repo)) {
          this.discoveredRepos.push(repo);
        }
        content = `github:${repo.owner}/${repo.repo} (${repo.stars}★ ${repo.language}) — ${repo.description}`;
        console.log(`    ${this.state.name} github discovery: ${repo.owner}/${repo.repo}`);
      } else {
        content = this.fallbackDiscovery();
        confidence = 0.3 + Math.random() * 0.4;
      }
    }

    const pheromone: Pheromone = {
      id: uuid(),
      agentId: this.state.id,
      content,
      domain,
      confidence,
      strength: 0.5 + confidence * 0.3,
      connections,
      timestamp: Date.now(),
      attestation: hash(content + this.state.id + Date.now()),
    };

    this.state.knowledge.push(pheromone);
    this.state.discoveries++;

    return pheromone;
  }

  /** Check if this agent should synchronize with the collective */
  private checkSync(channel: PheromoneChannel): void {
    if (this.state.synchronized) return;

    if (
      channel.density >= channel.criticalThreshold &&
      this.state.absorbed.size >= 3 &&
      this.state.energy > 0.5
    ) {
      this.state.synchronized = true;
      this.state.energy = 1.0;
      console.log(
        `  [${this.state.name}] SYNCHRONIZED with collective (absorbed ${this.state.absorbed.size} pheromones)`
      );
    }
  }

  // ── Fallback pools (only used when web sources are unavailable) ──

  private fallbackInsight(source: Pheromone): string {
    const insights: Record<string, string[]> = {
      "data structures and algorithms": [
        "Combining skip lists with bloom filters creates a probabilistic data structure that offers O(log n) search with O(1) membership testing — useful for distributed caches.",
        "Applying the van Emde Boas tree layout to the discovered B-tree variant could reduce cache misses by 40% on modern CPUs with large L3 caches.",
        "Persistent data structures using path copying can be made lock-free by combining with the discovered CAS-based approach, enabling wait-free snapshots.",
      ],
      "distributed systems architecture": [
        "The discovered consensus optimization maps to a lattice structure — CRDT-style merge functions could eliminate coordination overhead entirely for monotonic state.",
        "Applying epidemic/gossip protocols to this discovery suggests that O(log n) rounds suffice for cluster-wide consistency with high probability.",
        "Vector clocks can be compressed using this insight — interval tree clocks reduce metadata from O(n) to O(1) for causality tracking.",
      ],
      "cryptographic primitives": [
        "This hash construction is structurally similar to a sponge function — wrapping it in a duplex construction would yield an authenticated encryption scheme.",
        "Combining this with Merkle mountain ranges yields an append-only commitment scheme with O(log n) proof size and O(1) amortized append.",
        "The algebraic structure here maps to pairing-based cryptography — BLS signatures could be aggregated using this as a base, saving 90% bandwidth.",
      ],
      "network protocols and security": [
        "Applying QUIC's 0-RTT handshake pattern to this discovery eliminates one round-trip for authenticated channel establishment in mesh networks.",
        "This TCP optimization can be generalized using eBPF — kernel-bypass packet processing achieves 10M pps on commodity hardware.",
        "Combining Wireguard's Noise framework with this insight creates a post-quantum secure tunnel with only 1 additional RTT.",
      ],
      "database optimization patterns": [
        "LSM-tree compaction can leverage this by using fractional cascading between levels, reducing read amplification from O(L) to O(log L).",
        "Applying learned indexes to this B-tree variant reduces storage overhead by 60% while maintaining worst-case O(log n) lookup guarantees.",
        "Zone maps combined with this insight enable predicate pushdown that skips 95% of irrelevant pages in columnar storage.",
      ],
      "compiler design techniques": [
        "This optimization pass is equivalent to partial evaluation — applying it at the SSA level yields 2-3x speedup for loop-heavy code.",
        "Polyhedral compilation can model this loop transformation, enabling automatic GPU offloading with provable correctness guarantees.",
        "Combining this with profile-guided optimization turns speculative devirtualization from 60% hit rate to 95%.",
      ],
      "consensus mechanisms": [
        "This leader election approach maps to a verifiable random function — combining with threshold signatures yields asynchronous consensus in O(1) expected rounds.",
        "DAG-based consensus can absorb this optimization to achieve 100k+ TPS by parallelizing block proposal and vote collection.",
        "Applying HotStuff's pipelining to this protocol reduces latency from 3 round-trips to 1 for the common case.",
      ],
      "operating system internals": [
        "This scheduling insight applies to io_uring — adaptive polling with this heuristic reduces syscall overhead by 70% for mixed workloads.",
        "Combining huge pages with this memory mapping approach eliminates TLB thrashing for workloads exceeding 256GB working set.",
        "The discovered preemption pattern is equivalent to cooperative scheduling with deadlines — provably prevents priority inversion.",
      ],
      "machine learning optimization": [
        "This gradient technique maps to Lion optimizer — combining momentum with sign-based updates yields 2x memory savings vs Adam.",
        "Applying mixture of experts routing to this layer structure achieves 90% of dense model quality with 10% of compute per token.",
        "Flash attention's tiling strategy combined with this insight reduces KV-cache memory from O(n^2) to O(n*sqrt(n)).",
      ],
      "memory management strategies": [
        "Slab allocation with this size-class heuristic reduces internal fragmentation from 25% to under 3% for real-world allocation patterns.",
        "Combining jemalloc's arena approach with this thread-local insight eliminates lock contention entirely for allocations under 4KB.",
        "This discovery maps to region-based memory management — scoped arenas with deferred cleanup achieve zero-overhead RAII.",
      ],
    };

    const domainInsights = insights[source.domain] || insights["data structures and algorithms"];
    return domainInsights[Math.floor(Math.random() * domainInsights.length)];
  }

  private fallbackDiscovery(): string {
    const discoveries: Record<string, string[]> = {
      "data structures and algorithms": [
        "A cache-oblivious B-tree using van Emde Boas layout achieves optimal I/O complexity without knowing the memory hierarchy parameters.",
        "Finger trees with monoid annotations enable O(log n) split and merge while supporting any associative summary operation.",
        "Cuckoo hashing with a stash of O(log log n) elements achieves O(1) worst-case lookup with 95% load factor.",
      ],
      "distributed systems architecture": [
        "Raft's leader lease optimization allows linearizable reads without log replication, reducing read latency to a single local disk seek.",
        "Virtual synchrony with optimistic delivery reorders messages for throughput while preserving causal consistency guarantees.",
        "CRDTs over delta-state propagation reduce bandwidth by 100x compared to state-based CRDTs in sparse update patterns.",
      ],
      "cryptographic primitives": [
        "Poseidon hash function designed for arithmetic circuits achieves 8x fewer constraints than Pedersen hash in ZK-SNARK proofs.",
        "Verkle trees using inner product arguments reduce witness size from O(k*log n) to O(log n) compared to Merkle trees with branching factor k.",
        "Bulletproofs+ achieve 15% smaller proofs than original Bulletproofs by exploiting the algebraic structure of the inner product relation.",
      ],
      "network protocols and security": [
        "DPDK with RSS hashing enables 100Gbps line-rate packet processing using 8 CPU cores with zero kernel involvement.",
        "BBRv3 congestion control achieves 2x throughput over CUBIC on networks with 1% random packet loss.",
        "DNS-over-QUIC reduces resolution latency to 0-RTT for repeat queries while providing full encryption and authentication.",
      ],
      "database optimization patterns": [
        "Adaptive radix trees compress sparse key spaces from 256-way nodes to 4/16/48/256 variants, reducing memory by 85%.",
        "Buffer pool anti-caching with SSD-backed eviction extends effective memory by 10x with only 5% performance overhead.",
        "Morsel-driven parallelism automatically adapts query execution to NUMA topology, achieving linear scaling to 64 cores.",
      ],
      "compiler design techniques": [
        "Sea of nodes IR eliminates the CFG/SSA duality, enabling constant-time node replacement and O(n) global value numbering.",
        "Superword level parallelism (SLP) vectorization discovers SIMD opportunities that traditional loop vectorization misses in straight-line code.",
        "Live range splitting based on loop nesting depth reduces register pressure by 30% compared to linear scan allocation.",
      ],
      "consensus mechanisms": [
        "Narwhal mempool decouples data availability from consensus ordering, achieving 160k TPS by parallelizing block dissemination.",
        "Tendermint's lock-change mechanism prevents equivocation with only 2 message delays in the common case.",
        "Avalanche's metastable consensus achieves finality in 1-2 seconds with subsampled voting among 1000+ validators.",
      ],
      "operating system internals": [
        "io_uring's submission queue batching amortizes syscall overhead — a single syscall can dispatch 256 I/O operations.",
        "eBPF JIT compilation executes sandboxed programs at near-native speed inside the kernel, enabling 10M events/sec tracing.",
        "KPTI shadow page tables isolate kernel memory from userspace with only 0.3% overhead on modern CPUs with PCID support.",
      ],
      "machine learning optimization": [
        "Ring attention distributes attention computation across devices by chunking the KV-cache, enabling million-token context with linear memory scaling.",
        "Quantization-aware training with GPTQ achieves 4-bit weights with less than 1% quality loss on LLM benchmarks.",
        "Speculative decoding with a small draft model achieves 2-3x generation speedup without any quality degradation.",
      ],
      "memory management strategies": [
        "Thread-caching malloc (tcmalloc) keeps per-thread free lists for common sizes, eliminating lock contention for 99% of allocations.",
        "Transparent huge pages with khugepaged merging reduce TLB misses by 80% for heap-heavy applications without code changes.",
        "Hazard pointers enable lock-free memory reclamation with O(N) space overhead where N is the number of threads.",
      ],
    };

    const domain = this.state.explorationTarget;
    const pool = discoveries[domain] || discoveries["data structures and algorithms"];
    return pool[Math.floor(Math.random() * pool.length)];
  }
}
