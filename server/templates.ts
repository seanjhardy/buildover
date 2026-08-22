/**
 * Template codebases: local directories the user registers as starting points
 * for new projects. Stored globally in ~/.buildover/templates.json (same shape
 * of storage as mcp-servers.json) so templates are available regardless of
 * which repo is open.
 *
 * Creating a project copies the template's *tracked and non-ignored* files —
 * see `copyTemplateTree` — then optionally runs git init, an initial commit,
 * and `gh repo create` for the chosen GitHub account.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  CreateProjectRequest,
  CreateProjectStep,
  TemplateInfo,
} from "../src/types.js";
import { createGitHubRepo } from "./github.js";
import { gitInitWithCommit, gitPushInitial, gitSetRemote } from "./git.js";
import { patchPrefs } from "./prefs.js";
import { ensureRepo, touchRecent } from "./repos.js";

const execFileAsync = promisify(execFile);

const BUILDOVER_HOME = join(homedir(), ".buildover");
const TEMPLATES_PATH = join(BUILDOVER_HOME, "templates.json");

/**
 * Directories skipped when a template is not a git repo, where we have no
 * .gitignore rules to honour. Everything the user picked in the modal that
 * *is* a git repo goes through `git ls-files` instead.
 */
const FALLBACK_EXCLUDES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".DS_Store",
  ".pytest_cache",
  ".mypy_cache",
  "target",
]);

// ── Registry ────────────────────────────────────────────────────────────────

interface StoredTemplate {
  id: string;
  name: string;
  path: string;
  description?: string;
  createdAt: string;
}

async function readStored(): Promise<StoredTemplate[]> {
  try {
    const raw = await readFile(TEMPLATES_PATH, "utf8");
    const parsed = JSON.parse(raw) as { templates?: StoredTemplate[] };
    return parsed.templates ?? [];
  } catch {
    return [];
  }
}

async function writeStored(templates: StoredTemplate[]): Promise<void> {
  await mkdir(BUILDOVER_HOME, { recursive: true });
  await writeFile(
    TEMPLATES_PATH,
    JSON.stringify({ templates }, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Lists registered templates, annotating each with whether its directory still
 * exists and whether it is a git repo. Missing templates are kept in the list
 * (rather than silently dropped) so the user can see what broke and remove it.
 */
export async function listTemplates(): Promise<TemplateInfo[]> {
  const stored = await readStored();
  return Promise.all(
    stored.map(async (t) => {
      const s = await stat(t.path).catch(() => null);
      const exists = Boolean(s?.isDirectory());
      return {
        ...t,
        exists,
        isGitRepo: exists ? await isGitRepo(t.path) : false,
      };
    }),
  );
}

export async function addTemplate(
  rawPath: string,
  name?: string,
  description?: string,
): Promise<TemplateInfo> {
  if (!rawPath || !isAbsolute(rawPath)) {
    throw new Error("Template path must be absolute");
  }
  const path = resolve(rawPath);
  const s = await stat(path).catch(() => null);
  if (!s?.isDirectory()) throw new Error(`Not a directory: ${path}`);

  const stored = await readStored();
  const existing = stored.find((t) => t.path === path);
  if (existing) throw new Error(`Already registered as a template: ${existing.name}`);

  const template: StoredTemplate = {
    id: `tpl_${Math.random().toString(36).slice(2, 10)}`,
    name: name?.trim() || basename(path) || path,
    path,
    ...(description?.trim() ? { description: description.trim() } : {}),
    createdAt: new Date().toISOString(),
  };
  await writeStored([...stored, template]);
  return { ...template, exists: true, isGitRepo: await isGitRepo(path) };
}

export async function updateTemplate(
  id: string,
  patch: { name?: string; description?: string },
): Promise<void> {
  const stored = await readStored();
  const idx = stored.findIndex((t) => t.id === id);
  if (idx < 0) throw new Error(`No such template: ${id}`);
  const next = { ...stored[idx] };
  if (patch.name !== undefined) next.name = patch.name.trim() || next.name;
  if (patch.description !== undefined) {
    const d = patch.description.trim();
    if (d) next.description = d;
    else delete next.description;
  }
  stored[idx] = next;
  await writeStored(stored);
}

export async function removeTemplate(id: string): Promise<void> {
  const stored = await readStored();
  await writeStored(stored.filter((t) => t.id !== id));
}

// ── Copying ─────────────────────────────────────────────────────────────────

async function isGitRepo(path: string): Promise<boolean> {
  const s = await stat(join(path, ".git")).catch(() => null);
  return s !== null;
}

/**
 * Enumerates the files to copy out of a template, relative to its root.
 *
 * For a git repo we ask git itself: `ls-files -co --exclude-standard` lists
 * tracked files plus untracked ones that .gitignore does *not* exclude — which
 * is exactly "everything meaningfully part of the project", and naturally drops
 * node_modules, build output and .env files without us maintaining a list.
 * `-z` avoids quoting surprises for paths with spaces or unicode.
 */
async function listTemplateFiles(templatePath: string): Promise<string[]> {
  if (await isGitRepo(templatePath)) {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: templatePath, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  }

  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(templatePath, rel), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries) {
      if (FALLBACK_EXCLUDES.has(entry.name)) continue;
      const childRel = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  };
  await walk("");
  return files;
}

async function copyTemplateTree(
  templatePath: string,
  dest: string,
): Promise<number> {
  const files = await listTemplateFiles(templatePath);
  let copied = 0;
  for (const rel of files) {
    const from = join(templatePath, rel);
    // `ls-files -c` also reports staged-but-deleted paths and submodule
    // gitlinks; skip anything that isn't a real file on disk.
    const s = await stat(from).catch(() => null);
    if (!s?.isFile()) continue;
    const to = join(dest, rel);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    copied += 1;
  }
  return copied;
}

// ── Project creation ────────────────────────────────────────────────────────

/**
 * Rejects names that would escape the chosen parent directory or produce a
 * path GitHub cannot represent as a repo name.
 */
function validateProjectName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("A project name is required");
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      "Project name may only contain letters, numbers, dots, dashes and underscores",
    );
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error("Invalid project name");
  }
  return trimmed;
}

export async function createProjectFromTemplate(
  req: CreateProjectRequest,
): Promise<{ repo: Awaited<ReturnType<typeof ensureRepo>>; steps: CreateProjectStep[] }> {
  const name = validateProjectName(req.name ?? "");
  if (!req.parentDir || !isAbsolute(req.parentDir)) {
    throw new Error("A destination folder is required");
  }
  const parent = await stat(req.parentDir).catch(() => null);
  if (!parent?.isDirectory()) {
    throw new Error(`Not a directory: ${req.parentDir}`);
  }

  // No templateId means "empty project": create the folder and nothing else.
  const templates = await readStored();
  const template = req.templateId
    ? templates.find((t) => t.id === req.templateId)
    : null;
  if (req.templateId && !template) {
    throw new Error(`No such template: ${req.templateId}`);
  }
  if (template && !(await stat(template.path).catch(() => null))?.isDirectory()) {
    throw new Error(`Template folder no longer exists: ${template.path}`);
  }

  const dest = join(resolve(req.parentDir), name);
  if (await stat(dest).catch(() => null)) {
    throw new Error(`Destination already exists: ${dest}`);
  }

  const steps: CreateProjectStep[] = [];
  const step = (label: string, detail?: string): void => {
    steps.push({ label, status: "ok", ...(detail ? { detail } : {}) });
  };

  try {
    await mkdir(dest, { recursive: true });
    if (!template) {
      step("Created an empty project folder", dest);
    } else {
      const copied = await copyTemplateTree(template.path, dest);
      step(
        `Copied ${copied} file${copied === 1 ? "" : "s"} from ${template.name}`,
        (await isGitRepo(template.path))
          ? "Skipped files excluded by the template's .gitignore"
          : "Template is not a git repo — skipped common build and dependency folders",
      );
    }
  } catch (err) {
    // A failed copy leaves a half-populated directory; remove it so the user
    // can retry with the same name.
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  await patchPrefs({ lastProjectLocation: resolve(req.parentDir) });

  // Past this point the project exists on disk and is useful on its own, so
  // git/GitHub failures are reported as failed steps rather than aborting and
  // deleting the user's new project.
  if (req.initGit) {
    try {
      await gitInitWithCommit(
        dest,
        req.commit ? req.commitMessage?.trim() || "Initial commit" : null,
      );
      step(req.commit ? "Initialised git and created initial commit" : "Initialised git");
    } catch (err) {
      steps.push({ label: "Initialise git", status: "failed", detail: errText(err) });
      return { repo: await register(dest), steps };
    }
  }

  if (req.github) {
    const { account, owner, visibility, description, push } = req.github;
    let url: string;
    try {
      url = await createGitHubRepo({
        account,
        owner,
        name,
        visibility,
        description,
      });
      step(`Created ${visibility} repository ${owner}/${name}`, url);
    } catch (err) {
      steps.push({
        label: "Create GitHub repository",
        status: "failed",
        detail: errText(err),
      });
      return { repo: await register(dest), steps };
    }

    try {
      await gitSetRemote(dest, "origin", url);
      step("Added origin remote");
    } catch (err) {
      steps.push({ label: "Add origin remote", status: "failed", detail: errText(err) });
      return { repo: await register(dest), steps };
    }

    if (push && req.initGit && req.commit) {
      try {
        await gitPushInitial(dest);
        step("Pushed initial commit to origin");
      } catch (err) {
        steps.push({
          label: "Push to origin",
          status: "failed",
          detail: errText(err),
        });
      }
    }
  }

  return { repo: await register(dest), steps };
}

async function register(dest: string): Promise<Awaited<ReturnType<typeof ensureRepo>>> {
  const meta = await ensureRepo(dest);
  await touchRecent(meta);
  return meta;
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return err instanceof Error ? err.message : String(err);
}
