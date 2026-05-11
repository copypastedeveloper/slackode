import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

type SkillSource = "claude" | "opencode";

type Skill = {
  name: string;
  description: string;
  source: SkillSource;
  relPath: string;
};

const SKILL_ROOTS: Array<{ rel: string; source: SkillSource }> = [
  { rel: ".claude/skills", source: "claude" },
  { rel: ".opencode/skill", source: "opencode" },
  { rel: ".opencode/skills", source: "opencode" },
];

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;
const MAX_DESCRIPTION_CHARS = 300;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(FRONTMATTER_RE);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[kv[1].toLowerCase()] = v;
  }
  return out;
}

function discoverSkills(repoDir: string): Skill[] {
  const skills: Skill[] = [];
  for (const { rel, source } of SKILL_ROOTS) {
    const root = path.join(repoDir, rel);
    if (!existsSync(root)) continue;
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const entry of entries) {
      const skillDir = path.join(root, entry);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch { continue; }
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      let content: string;
      try { content = readFileSync(skillFile, "utf-8"); } catch { continue; }
      const fm = parseFrontmatter(content);
      const description = fm.description;
      if (!description) {
        console.warn(`[skills] ${rel}/${entry}/SKILL.md missing 'description' frontmatter — skipping`);
        continue;
      }
      skills.push({
        name: fm.name || entry,
        description: truncate(description, MAX_DESCRIPTION_CHARS),
        source,
        relPath: path.posix.join(rel, entry, "SKILL.md"),
      });
    }
  }
  return skills;
}

/**
 * Write a manifest of repo-supplied skills to .opencode/rules/skills.md.
 * The rules glob in opencode.json loads it into every session as an INDEX —
 * full skill bodies are read lazily when a task matches.
 *
 * If `allowSkills` is false, writes a placeholder explaining that skills
 * are disabled for this repo (so a previously-allowed manifest doesn't
 * linger after the admin turns the toggle off).
 */
export function writeSkillManifest(
  repoDir: string,
  opts: { allowSkills: boolean },
): void {
  const rulesDir = path.join(repoDir, ".opencode/rules");
  mkdirSync(rulesDir, { recursive: true });
  const out = path.join(rulesDir, "skills.md");

  if (!opts.allowSkills) {
    writeFileSync(out, "# Repo-supplied skills\n\nDisabled for this repo by admin.\n");
    return;
  }

  const skills = discoverSkills(repoDir);

  if (skills.length === 0) {
    writeFileSync(out, "# Repo-supplied skills\n\nNone discovered.\n");
    return;
  }

  const lines = [
    "# Repo-supplied skills",
    "",
    "Each entry below is a skill packaged in this repo. When the user's task matches a skill's description, Read the listed SKILL.md before acting — the body contains full instructions; this index only lists triggers.",
    "",
  ];
  for (const s of skills) {
    lines.push(`- **${s.name}** (${s.source}) — ${s.description}`);
    lines.push(`  Read: \`${s.relPath}\``);
  }
  lines.push("");
  writeFileSync(out, lines.join("\n"));
  console.log(`[skills] Wrote manifest with ${skills.length} skill(s) to ${out}`);
}
