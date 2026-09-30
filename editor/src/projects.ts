import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Projects. A project is one map and the chats about it, kept in a folder of its own under the maps folder:
//
//   maps/<slug>/project.json        name and dates
//   maps/<slug>/<slug>.ymap         the map (the file name is also the ymap's in-game name)
//   maps/<slug>/<slug>.layout.json  editor folders and hidden props
//   maps/<slug>/threads.json        which chats belong to the project, and their pins and settled state
//   maps/<slug>/exports/<target>/   exports
//
// The chats themselves are Agent SDK sessions, saved by the SDK in one place for all projects.

export interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  dir: string;
  ymapPath: string;
  createdAt: number;
}

interface ProjectFile {
  version: 1;
  id: string;
  name: string;
  createdAt: number;
}

export interface ThreadMeta {
  pinned?: boolean;
  settled?: boolean; // read-only until unsettled
}

interface ThreadsFile {
  version: 1;
  lastThreadId?: string;
  threads: Record<string, ThreadMeta>;
}

const PROJECT_FILE = "project.json";
const THREADS_FILE = "threads.json";

// Folder-safe name: lowercase letters, digits and _ (also what FiveM and friends accept as a resource name).
export function slugify(name: string) {
  const turkish: Record<string, string> = { ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u" };
  const slug = name
    .replace(/[çğıİöşü]/gi, (c) => turkish[c] ?? turkish[c.toLowerCase()] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 40);
  return slug || "project";
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// The chats of one project and what the SDK doesn't store about them.
export class ProjectThreads {
  private data: ThreadsFile;

  constructor(private readonly file: string) {
    const raw = readJson<ThreadsFile>(file);
    this.data = { version: 1, lastThreadId: raw?.lastThreadId, threads: raw?.threads ?? {} };
  }

  has(id: string) {
    return id in this.data.threads;
  }

  ids() {
    return Object.keys(this.data.threads);
  }

  meta(id: string): ThreadMeta {
    return this.data.threads[id] ?? {};
  }

  add(id: string, meta: ThreadMeta = {}) {
    if (this.has(id)) return;
    this.data.threads[id] = meta;
    this.save();
  }

  update(id: string, patch: ThreadMeta) {
    this.data.threads[id] = { ...this.data.threads[id], ...patch };
    this.save();
  }

  forget(id: string) {
    delete this.data.threads[id];
    if (this.data.lastThreadId === id) delete this.data.lastThreadId;
    this.save();
  }

  get lastThreadId() {
    return this.data.lastThreadId;
  }

  set lastThreadId(id: string | undefined) {
    if (this.data.lastThreadId === id) return;
    this.data.lastThreadId = id;
    this.save();
  }

  private save() {
    writeJson(this.file, this.data);
  }
}

export class ProjectStore {
  private threadFiles = new Map<string, ProjectThreads>();

  // root: the maps folder. statePath: where the last open project is remembered.
  constructor(
    readonly root: string,
    private readonly statePath: string,
  ) {
    fs.mkdirSync(root, { recursive: true });
  }

  // Newest first, so the order doesn't jump around while you switch between projects.
  list(): ProjectInfo[] {
    const projects: ProjectInfo[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.root, entry.name);
      const file = readJson<ProjectFile>(path.join(dir, PROJECT_FILE));
      if (!file?.id) continue;
      projects.push({
        id: file.id,
        name: file.name || entry.name,
        slug: entry.name,
        dir,
        ymapPath: path.join(dir, `${entry.name}.ymap`),
        createdAt: file.createdAt ?? 0,
      });
    }
    return projects.sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
  }

  get(id: string) {
    return this.list().find((p) => p.id === id);
  }

  threads(project: ProjectInfo) {
    let threads = this.threadFiles.get(project.id);
    if (!threads) {
      threads = new ProjectThreads(path.join(project.dir, THREADS_FILE));
      this.threadFiles.set(project.id, threads);
    }
    return threads;
  }

  // The project a chat belongs to.
  projectOf(threadId: string) {
    return this.list().find((p) => this.threads(p).has(threadId));
  }

  create(name: string, createdAt = Date.now()): ProjectInfo {
    const trimmed = name.trim() || "Untitled project";
    const slug = this.freeSlug(slugify(trimmed));
    const dir = path.join(this.root, slug);
    fs.mkdirSync(dir, { recursive: true });
    const file: ProjectFile = { version: 1, id: randomUUID(), name: trimmed, createdAt };
    writeJson(path.join(dir, PROJECT_FILE), file);
    return this.get(file.id)!;
  }

  // A new project holding a copy of an existing .ymap (and its folder layout, if it has one next to it).
  importYmap(file: string): ProjectInfo {
    const name = path.basename(file).replace(/\.ymap$/i, "");
    const project = this.create(name);
    fs.copyFileSync(file, project.ymapPath);
    const layout = file.replace(/\.ymap$/i, "") + ".layout.json";
    if (fs.existsSync(layout)) fs.copyFileSync(layout, project.ymapPath.replace(/\.ymap$/i, "") + ".layout.json");
    return project;
  }

  rename(id: string, name: string) {
    const project = this.get(id);
    if (!project) throw new Error("No such project");
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Name is empty");
    const file = readJson<ProjectFile>(path.join(project.dir, PROJECT_FILE))!;
    writeJson(path.join(project.dir, PROJECT_FILE), { ...file, name: trimmed });
  }

  forget(id: string) {
    this.threadFiles.delete(id);
    if (this.lastProjectId === id) this.lastProjectId = undefined;
  }

  get lastProjectId(): string | undefined {
    return readJson<{ lastProjectId?: string }>(this.statePath)?.lastProjectId;
  }

  set lastProjectId(id: string | undefined) {
    writeJson(this.statePath, { ...readJson<object>(this.statePath), lastProjectId: id });
  }

  // Maps saved before projects existed (maps/<name>.ymap) each become a project; their FiveM exports
  // (maps/fivem/<name>/) move into it. Safe to run on every start.
  migrateLooseMaps(): ProjectInfo[] {
    const created: ProjectInfo[] = [];
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ymap$/i.test(entry.name)) continue;
      const source = path.join(this.root, entry.name);
      const base = entry.name.replace(/\.ymap$/i, "");
      const project = this.create(base, fs.statSync(source).mtimeMs);
      fs.renameSync(source, project.ymapPath);
      const layout = path.join(this.root, `${base}.layout.json`);
      if (fs.existsSync(layout)) fs.renameSync(layout, project.ymapPath.replace(/\.ymap$/i, "") + ".layout.json");
      const fivem = path.join(this.root, "fivem", base);
      if (fs.existsSync(fivem)) {
        fs.mkdirSync(path.join(project.dir, "exports", "fivem"), { recursive: true });
        fs.renameSync(fivem, path.join(project.dir, "exports", "fivem", base));
      }
      created.push(project);
    }
    const fivemDir = path.join(this.root, "fivem");
    if (fs.existsSync(fivemDir) && fs.readdirSync(fivemDir).length === 0) fs.rmdirSync(fivemDir);
    return created;
  }

  // Chats from before projects existed were one global list (legacyPath, threads.json in user data). Each goes
  // to the project made from the map it last worked on, or else to an "Earlier chats" project. The old file is
  // renamed afterwards, so this runs once. Returns what moved where.
  migrateLegacyChats(legacyPath: string, sessions: { sessionId: string; summary: string }[]) {
    const legacy = readJson<{ lastThreadId?: string; threads?: Record<string, { pinned?: boolean; mapPath?: string | null }> }>(legacyPath);
    if (!legacy) return [];
    const all = this.list();
    const claimed = new Set(all.flatMap((p) => this.threads(p).ids()));
    const moved: { chat: string; project: string }[] = [];
    let fallback: ProjectInfo | undefined;
    for (const s of sessions) {
      if (claimed.has(s.sessionId)) continue;
      const meta = legacy.threads?.[s.sessionId] ?? {};
      const mapFile = meta.mapPath ? path.basename(meta.mapPath).toLowerCase() : null;
      const target = (mapFile && all.find((p) => path.basename(p.ymapPath).toLowerCase() === mapFile)) || (fallback ??= this.create("Earlier chats"));
      const threads = this.threads(target);
      threads.add(s.sessionId, { pinned: meta.pinned });
      if (legacy.lastThreadId === s.sessionId) {
        threads.lastThreadId = s.sessionId;
        this.lastProjectId = target.id;
      }
      moved.push({ chat: s.summary, project: target.name });
    }
    fs.renameSync(legacyPath, legacyPath.replace(/\.json$/i, ".legacy.json"));
    return moved;
  }

  // A slug no other folder in the maps folder uses (projects or not).
  private freeSlug(base: string) {
    const taken = new Set(fs.readdirSync(this.root).map((n) => n.toLowerCase()));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  }
}
