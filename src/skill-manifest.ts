import { existsSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Remove any stale skill manifest from a repo's .opencode/rules/ directory.
 *
 * Earlier versions generated a markdown "skills index" here and loaded it as
 * agent instructions. That was a redundant reimplementation of skill support:
 * opencode NATIVELY discovers and surfaces `.claude/skills/<name>/SKILL.md`
 * (and `.opencode/skill[s]/`) once the `skill` tool is enabled — which we now do
 * in opencode-config.ts. The agent treated the markdown index as foreign reference
 * docs and disowned it, while native discovery makes the skills its own.
 *
 * We keep this function (and its call sites) only to delete a lingering skills.md
 * — important because the repo checkout lives on a persistent EFS volume where a
 * previously-written manifest would otherwise survive and get loaded as duplicate
 * instructions. `allowSkills` is accepted for call-site compatibility but unused;
 * per-repo gating of native skills is handled via opencode's `permission.skill`.
 */
export function writeSkillManifest(
  repoDir: string,
  _opts: { allowSkills: boolean },
): void {
  const out = path.join(repoDir, ".opencode/rules", "skills.md");
  if (existsSync(out)) {
    rmSync(out, { force: true });
    console.log(`[skills] Removed stale manifest ${out}; using opencode native skill discovery.`);
  }
}
