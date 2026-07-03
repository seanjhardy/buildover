import path from "path";
import os from "os";
import { existsSync, mkdirSync, readdirSync } from "fs";

const MODELS_DIR = path.join(os.homedir(), ".buildover", "models");
const MODEL_URI = "hf:Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF:Q4_K_M";

const COMMON_COMMANDS = new Set([
  "ls","cd","cp","mv","rm","mkdir","rmdir","touch","cat","head","tail","less","more",
  "grep","rg","find","sed","awk","sort","uniq","wc","cut","tr","tee","xargs",
  "echo","printf","export","env","set","unset","alias","source","which","whereis","type",
  "git","npm","npx","yarn","pnpm","bun","node","python","python3","pip","pip3",
  "docker","docker-compose","kubectl","terraform","make","cmake","cargo","go","rustc",
  "ssh","scp","rsync","curl","wget","tar","zip","unzip","gzip","gunzip",
  "chmod","chown","chgrp","ln","df","du","free","top","htop","ps","kill","killall",
  "man","history","clear","exit","pwd","whoami","hostname","date","cal","time",
  "brew","apt","apt-get","yum","dnf","pacman","snap","flatpak",
  "vim","vi","nano","emacs","code","subl","open","pbcopy","pbpaste",
  "nvm","rbenv","pyenv","volta","fnm","deno","tsx","ts-node","tsc","esbuild","vite",
  "jest","vitest","mocha","pytest","mvn","gradle","ant","sbt",
  "nc","nslookup","dig","ping","traceroute","ifconfig","ip","netstat","lsof",
  "crontab","systemctl","launchctl","service","journalctl",
  "aws","gcloud","az","heroku","vercel","netlify","fly","railway",
  "screen","tmux","bg","fg","jobs","nohup","watch","yes","true","false",
  "test","[","[[","if","then","else","fi","for","while","do","done","case","esac",
  "&&","||","|","sudo","su",
]);

type Engine = {
  infill: (
    prefix: string,
    suffix: string,
    opts: {
      maxTokens?: number;
      temperature?: number;
      customStopTriggers?: string[];
      signal?: AbortSignal;
      stopOnAbortSignal?: boolean;
    },
  ) => Promise<string>;
  clearHistory: () => Promise<void>;
};

let engine: Engine | null = null;
let initializing = false;
let initFailed = false;

async function initEngine(): Promise<void> {
  if (engine || initializing || initFailed) return;
  initializing = true;

  try {
    mkdirSync(MODELS_DIR, { recursive: true });

    const { getLlama, LlamaCompletion, createModelDownloader } = await import(
      "node-llama-cpp"
    );

    let modelPath: string | undefined;

    const ggufFiles = existsSync(MODELS_DIR)
      ? readdirSync(MODELS_DIR).filter(
          (f) => f.endsWith(".gguf") && f.toLowerCase().includes("qwen"),
        )
      : [];

    if (ggufFiles.length > 0) {
      modelPath = path.join(MODELS_DIR, ggufFiles[0]);
      console.log("[autocomplete] Found model:", ggufFiles[0]);
    } else {
      console.log("[autocomplete] Downloading model (one-time, ~400 MB)…");
      const downloader = await createModelDownloader({
        modelUri: MODEL_URI,
        dirPath: MODELS_DIR,
        onProgress({ totalSize, downloadedSize }) {
          const pct =
            totalSize > 0
              ? Math.round((downloadedSize / totalSize) * 100)
              : 0;
          process.stdout.write(`\r[autocomplete] Downloading… ${pct}%`);
        },
      });
      modelPath = await downloader.download();
      console.log("\n[autocomplete] Download complete");
    }

    console.log("[autocomplete] Loading model…");
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath: modelPath! });
    const context = await model.createContext({ contextSize: 2048 });
    const sequence = context.getSequence();
    const completion = new LlamaCompletion({ contextSequence: sequence });

    engine = {
      infill: async (prefix, suffix, opts) => {
        const r = await completion.generateInfillCompletionWithMeta(
          prefix,
          suffix,
          {
            maxTokens: opts.maxTokens,
            temperature: opts.temperature,
            customStopTriggers: opts.customStopTriggers,
            signal: opts.signal,
            stopOnAbortSignal: opts.stopOnAbortSignal,
          },
        );
        return r.response;
      },
      clearHistory: () => sequence.clearHistory(),
    };

    console.log("[autocomplete] Ready");
  } catch (err) {
    console.error("[autocomplete] Init failed:", err);
    initFailed = true;
  } finally {
    initializing = false;
  }
}

initEngine();

export type CompletionResult = {
  text: string;
  mode: "append" | "replace";
};

function isNaturalLanguage(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2) return false;
  const first = words[0].toLowerCase();
  if (first.includes("/") || first.includes(".")) return false;
  return !COMMON_COMMANDS.has(first);
}

export async function completeTerminalCommand(opts: {
  line: string;
  history?: string[];
  cwd?: string;
  dirEntries?: string[];
  signal?: AbortSignal;
}): Promise<CompletionResult | null> {
  if (!engine) return null;

  const { line, history = [], cwd, dirEntries } = opts;
  if (!line || line.trim().length < 2) return null;

  if (isNaturalLanguage(line)) {
    return translateNaturalLanguage(line, cwd, dirEntries, opts.signal);
  }

  const prefixParts: string[] = [];
  if (cwd) prefixParts.push(`# cwd: ${cwd}`);
  if (dirEntries?.length) {
    prefixParts.push(`# files: ${dirEntries.slice(0, 30).join(", ")}`);
  }
  for (const cmd of history.slice(-5)) prefixParts.push(`$ ${cmd}`);
  prefixParts.push(`$ ${line}`);

  const prefix = prefixParts.join("\n");
  const suffix = "\n$ ";

  try {
    await engine.clearHistory();
    const raw = await engine.infill(prefix, suffix, {
      maxTokens: 40,
      temperature: 0,
      customStopTriggers: ["\n", "```", "$ "],
      signal: opts.signal,
      stopOnAbortSignal: true,
    });

    const text = cleanCompletion(raw, line);
    return text ? { text, mode: "append" } : null;
  } catch {
    return null;
  }
}

async function translateNaturalLanguage(
  line: string,
  cwd?: string,
  dirEntries?: string[],
  signal?: AbortSignal,
): Promise<CompletionResult | null> {
  if (!engine) return null;

  const prefixParts: string[] = [];
  if (cwd) prefixParts.push(`# cwd: ${cwd}`);
  if (dirEntries?.length) {
    prefixParts.push(`# files: ${dirEntries.slice(0, 30).join(", ")}`);
  }
  prefixParts.push(
    "# translate natural language to shell command",
    "# list files → ls -la",
    "# show disk usage → du -sh *",
    "# find large files → find . -size +100M -type f",
    "# install dependencies → npm install",
    "# start dev server → npm run dev",
    `# ${line} →`,
  );

  const prefix = prefixParts.join("\n");
  const suffix = "\n#";

  try {
    await engine.clearHistory();
    const raw = await engine.infill(prefix, suffix, {
      maxTokens: 60,
      temperature: 0,
      customStopTriggers: ["\n", "```", "# "],
      signal,
      stopOnAbortSignal: true,
    });

    let text = raw.split("\n")[0].trim();
    if (!text) return null;
    text = text.replace(/^[`"']+|[`"']+$/g, "");
    if (!text || text.length > 120) return null;

    return { text, mode: "replace" };
  } catch {
    return null;
  }
}

function cleanCompletion(raw: string, inputLine: string): string | null {
  let text = raw.split("\n")[0].trimEnd();
  if (!text) return null;

  text = text.replace(/^[`"']+|[`"']+$/g, "");

  if (text.toLowerCase().startsWith(inputLine.toLowerCase())) {
    text = text.slice(inputLine.length);
  }

  if (!text || text.trimEnd().length > 80) return null;
  if (inputLine.endsWith(text.trim())) return null;

  return text;
}
