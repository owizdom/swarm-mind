import { execSync, execFileSync } from "child_process";
import path from "path";
import fs from "fs";
import simpleGit, { SimpleGit } from "simple-git";
import type { GitHubRepo, GitHubIssue, RepoContext, FileScore } from "./types";

const WORKSPACE_DIR = path.join(process.cwd(), "workspace");
const SANDBOX_LOG = path.join(WORKSPACE_DIR, "sandbox-log.json");

function isSandboxMode(): boolean {
  return process.env.SANDBOX_MODE !== "false";
}

function ensureWorkspace(): void {
  if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  }
}

// ── gh CLI wrapper ──

function ghExec(args: string[], timeoutMs = 15000): string {
  try {
    const result = execFileSync("gh", args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [gh] Error: ${message.slice(0, 200)}`);
    return "";
  }
}

function appendSandboxLog(entry: Record<string, unknown>): void {
  ensureWorkspace();
  let log: Record<string, unknown>[] = [];
  try {
    if (fs.existsSync(SANDBOX_LOG)) {
      log = JSON.parse(fs.readFileSync(SANDBOX_LOG, "utf-8"));
    }
  } catch { /* fresh log */ }
  log.push({ ...entry, timestamp: Date.now() });
  fs.writeFileSync(SANDBOX_LOG, JSON.stringify(log, null, 2));
}

// ── Discovery ──

export function discoverRepos(
  query: string,
  options?: { language?: string; minStars?: number; limit?: number }
): GitHubRepo[] {
  const limit = options?.limit || 10;
  const args = ["search", "repos", query, `--limit=${limit}`, "--json=fullName,description,language,stargazersCount"];
  if (options?.language) args.push(`--language=${options.language}`);
  if (options?.minStars) args.push(`--stars=>=${options.minStars}`);

  const raw = ghExec(args);

  if (!raw) return [];

  try {
    const results = JSON.parse(raw) as Array<{
      fullName?: string;
      description?: string;
      language?: string;
      stargazersCount?: number;
    }>;

    return results.map((r) => {
      const [owner, repo] = (r.fullName || "/").split("/");
      return {
        owner: owner || "",
        repo: repo || "",
        description: r.description || "",
        language: r.language || "",
        stars: r.stargazersCount || 0,
        topics: [],
        relevanceScore: 0,
      };
    }).filter((r) => r.owner && r.repo);
  } catch {
    return [];
  }
}

export function getTrendingRepos(
  topic: string,
  sinceDaysAgo = 7
): GitHubRepo[] {
  const since = new Date(Date.now() - sinceDaysAgo * 86400000)
    .toISOString()
    .split("T")[0];

  const q = encodeURIComponent(`topic:${topic} created:>=${since} stars:>=5`);
  const raw = ghExec([
    "api",
    `/search/repositories?q=${q}&sort=stars&per_page=10`,
    "--jq", ".items",
  ]);

  if (!raw) return [];

  try {
    const items = JSON.parse(raw) as Array<{
      full_name?: string;
      description?: string;
      language?: string;
      stargazers_count?: number;
      topics?: string[];
    }>;

    return items.map((r) => {
      const [owner, repo] = (r.full_name || "/").split("/");
      return {
        owner: owner || "",
        repo: repo || "",
        description: r.description || "",
        language: r.language || "",
        stars: r.stargazers_count || 0,
        topics: r.topics || [],
        relevanceScore: 0,
      };
    }).filter((r) => r.owner && r.repo);
  } catch {
    return [];
  }
}

export function getActionableIssues(
  owner: string,
  repo: string,
  limit = 10
): GitHubIssue[] {
  const raw = ghExec([
    "issue", "list",
    "-R", `${owner}/${repo}`,
    "--state=open",
    `--limit=${limit}`,
    "--json=number,title,body,labels",
  ]);

  if (!raw) return [];

  try {
    const issues = JSON.parse(raw) as Array<{
      number?: number;
      title?: string;
      body?: string;
      labels?: Array<{ name?: string }>;
    }>;

    return issues.map((iss) => {
      const labels = (iss.labels || []).map((l) => l.name || "");
      let difficulty: GitHubIssue["difficulty"] = "medium";
      if (labels.some((l) => /good.first|beginner|easy/i.test(l))) difficulty = "easy";
      if (labels.some((l) => /complex|hard|expert/i.test(l))) difficulty = "hard";

      return {
        owner,
        repo,
        number: iss.number || 0,
        title: iss.title || "",
        body: (iss.body || "").slice(0, 2000),
        labels,
        difficulty,
        relevanceScore: 0,
      };
    });
  } catch {
    return [];
  }
}

// ── Context Building ──

export function buildRepoContext(
  owner: string,
  repo: string,
  focusTopic?: string
): RepoContext | null {
  const repoObj: GitHubRepo = {
    owner,
    repo,
    description: "",
    language: "",
    stars: 0,
    topics: [],
    relevanceScore: 0,
  };

  // Get repo info
  const infoRaw = ghExec([
    "repo", "view", `${owner}/${repo}`,
    "--json=description,primaryLanguage,stargazerCount,repositoryTopics",
  ]);

  if (infoRaw) {
    try {
      const info = JSON.parse(infoRaw) as {
        description?: string;
        primaryLanguage?: { name?: string };
        stargazerCount?: number;
        repositoryTopics?: Array<{ name?: string }>;
      };
      repoObj.description = info.description || "";
      repoObj.language = info.primaryLanguage?.name || "";
      repoObj.stars = info.stargazerCount || 0;
      repoObj.topics = (info.repositoryTopics || []).map((t) => t.name || "");
    } catch { /* keep defaults */ }
  }

  // Get file tree (limited depth)
  const treeRaw = ghExec([
    "api", `/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`,
    "--jq", "[.tree[].path] | .[:100]",
  ]);

  let structure: string[] = [];
  if (treeRaw) {
    try {
      structure = JSON.parse(treeRaw) as string[];
    } catch { /* empty tree */ }
  }

  // Get README excerpt
  const readmeRaw = ghExec([
    "api", `/repos/${owner}/${repo}/readme`,
    "--jq", ".content",
  ]);

  let readmeExcerpt = "";
  if (readmeRaw) {
    try {
      const decoded = Buffer.from(readmeRaw, "base64").toString("utf-8");
      readmeExcerpt = decoded.slice(0, 1500);
    } catch { /* no readme */ }
  }

  // Score key files
  const keywords = focusTopic ? focusTopic.split(/\s+/) : [];
  const keyFiles = scoreFiles(structure, keywords);

  // Get recent commits
  const commitsRaw = ghExec([
    "api", `/repos/${owner}/${repo}/commits?per_page=5`,
    "--jq", ".[].commit.message",
  ]);

  let recentCommits: string[] = [];
  if (commitsRaw) {
    recentCommits = commitsRaw.split("\n").filter(Boolean).slice(0, 5);
  }

  // Get actionable issues
  const issues = getActionableIssues(owner, repo, 5);

  return {
    repo: repoObj,
    structure,
    readmeExcerpt,
    keyFiles,
    issues,
    recentCommits,
  };
}

export function scoreFiles(
  filePaths: string[],
  keywords: string[],
  issue?: GitHubIssue
): FileScore[] {
  const scores: FileScore[] = [];

  for (const filePath of filePaths) {
    let score = 0;
    const reasons: string[] = [];
    const ext = path.extname(filePath).toLowerCase();
    const name = path.basename(filePath).toLowerCase();

    // Source file bonus
    if ([".ts", ".js", ".py", ".rs", ".go", ".sol"].includes(ext)) {
      score += 2;
      reasons.push("source file");
    }

    // Config/entry point bonus
    if (["index", "main", "app", "server", "lib"].some((k) => name.includes(k))) {
      score += 3;
      reasons.push("entry point");
    }

    // Test file bonus (lower priority but useful)
    if (name.includes("test") || name.includes("spec")) {
      score += 1;
      reasons.push("test file");
    }

    // Keyword matching
    for (const kw of keywords) {
      if (filePath.toLowerCase().includes(kw.toLowerCase())) {
        score += 2;
        reasons.push(`matches keyword: ${kw}`);
      }
    }

    // Issue title/label matching
    if (issue) {
      const issueTerms = issue.title.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
      for (const term of issueTerms) {
        if (filePath.toLowerCase().includes(term)) {
          score += 3;
          reasons.push(`matches issue term: ${term}`);
        }
      }
    }

    // Ignore uninteresting files
    if ([".md", ".txt", ".lock", ".json", ".yaml", ".yml", ".toml"].includes(ext) && !name.includes("config")) {
      score = Math.max(0, score - 2);
    }
    if (filePath.includes("node_modules/") || filePath.includes("dist/") || filePath.includes(".git/")) {
      continue;
    }

    if (score > 0) {
      scores.push({ path: filePath, score, reason: reasons.join(", "), keySnippets: [] });
    }
  }

  return scores.sort((a, b) => b.score - a.score).slice(0, 15);
}

export function readRepoFile(owner: string, repo: string, filePath: string): string {
  const raw = ghExec([
    "api", `/repos/${owner}/${repo}/contents/${filePath}`,
    "--jq", ".content",
  ]);

  if (!raw) return "";

  try {
    return Buffer.from(raw, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

// ── Git Operations ──

export async function cloneRepo(owner: string, repo: string): Promise<string> {
  ensureWorkspace();
  const repoDir = path.join(WORKSPACE_DIR, owner, repo);

  if (fs.existsSync(repoDir)) {
    // Already cloned — pull latest
    const git: SimpleGit = simpleGit(repoDir);
    try {
      await git.pull();
    } catch { /* offline or fresh clone */ }
    return repoDir;
  }

  fs.mkdirSync(path.join(WORKSPACE_DIR, owner), { recursive: true });

  const git: SimpleGit = simpleGit(WORKSPACE_DIR);
  await git.clone(`https://github.com/${owner}/${repo}.git`, repoDir, ["--depth=1"]);

  return repoDir;
}

export async function createBranch(
  repoPath: string,
  agentName: string,
  slug: string
): Promise<string> {
  const branchName = `swarm-mind/${agentName.toLowerCase()}/${slug}`;
  const git: SimpleGit = simpleGit(repoPath);
  await git.checkoutLocalBranch(branchName);
  return branchName;
}

export async function commitAndPush(
  repoPath: string,
  message: string,
  agentName: string
): Promise<boolean> {
  const git: SimpleGit = simpleGit(repoPath);

  if (isSandboxMode()) {
    // In sandbox mode, stage and commit locally but don't push
    await git.add(".");
    await git.commit(`[${agentName}] ${message}`);
    appendSandboxLog({
      action: "commit",
      repoPath,
      message: `[${agentName}] ${message}`,
      agentName,
    });
    console.log(`  [SANDBOX] Would push commit: "${message}" (logged to sandbox-log.json)`);
    return true;
  }

  await git.add(".");
  await git.commit(`[${agentName}] ${message}`);
  await git.push();
  return true;
}

export async function createPR(
  repoPath: string,
  title: string,
  body: string
): Promise<string | null> {
  if (isSandboxMode()) {
    appendSandboxLog({
      action: "create_pr",
      repoPath,
      title,
      body,
    });
    console.log(`  [SANDBOX] Would create PR: "${title}" (logged to sandbox-log.json)`);
    return `sandbox://pr/${Date.now()}`;
  }

  try {
    const result = execSync(
      `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`,
      { cwd: repoPath, encoding: "utf-8", timeout: 30000 }
    );
    return result.trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  [gh pr] Error: ${message.slice(0, 200)}`);
    return null;
  }
}
