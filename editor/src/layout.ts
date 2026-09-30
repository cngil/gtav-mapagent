import fs from "node:fs";
import { codewalker, type PlacedProp } from "./codewalker.js";

// Editor-only organisation of the map's props into named folders, plus hide/show. Nothing here is
// written into the .ymap; it lives next to it as <map>.layout.json.

export interface FolderInfo {
  name: string;
  hidden: boolean;
}

export interface LayoutProp extends PlacedProp {
  folder: string | null;
  hidden: boolean;
}

interface LayoutFile {
  version: 1;
  folders: { name: string; hidden: boolean; indices: number[] }[];
  hiddenIndices: number[];
}

export function layoutPathFor(ymapPath: string) {
  return ymapPath.replace(/\.ymap$/i, "") + ".layout.json";
}

class SceneLayout {
  // Insertion order is display order.
  private folders = new Map<string, { hidden: boolean }>();
  // By prop id. Entries for deleted props are kept on purpose: undo restores a prop under its old id.
  private folderOfProp = new Map<number, string>();
  // Changed since the last save. Folder and visibility edits don't count as unsaved changes in CodeWalker,
  // so the editor tracks them itself.
  dirty = false;

  reset() {
    this.folders.clear();
    this.folderOfProp.clear();
    this.dirty = false;
  }

  listFolders(): FolderInfo[] {
    return [...this.folders].map(([name, f]) => ({ name, hidden: f.hidden }));
  }

  folderOf(id: number): string | null {
    const folder = this.folderOfProp.get(id);
    return folder !== undefined && this.folders.has(folder) ? folder : null;
  }

  async props(): Promise<LayoutProp[]> {
    const props = await codewalker.listProps();
    return props.map((p) => ({ ...p, folder: this.folderOf(p.id), hidden: !!(p as { hidden?: boolean }).hidden }));
  }

  createFolder(name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Folder name is empty");
    if (!this.folders.has(trimmed)) {
      this.folders.set(trimmed, { hidden: false });
      this.dirty = true;
    }
    return trimmed;
  }

  renameFolder(from: string, to: string) {
    const target = to.trim();
    const folder = this.folders.get(from);
    if (!folder) throw new Error(`No folder named '${from}'`);
    if (!target) throw new Error("Folder name is empty");
    if (target === from) return;
    if (this.folders.has(target)) throw new Error(`A folder named '${target}' already exists`);
    // Rebuild to keep the folder's position in the order.
    this.folders = new Map([...this.folders].map(([name, f]) => (name === from ? [target, f] : [name, f])));
    for (const [id, name] of this.folderOfProp) {
      if (name === from) this.folderOfProp.set(id, target);
    }
    this.dirty = true;
  }

  // Props of a removed folder move to the top level and become visible again.
  async deleteFolder(name: string) {
    const folder = this.folders.get(name);
    if (!folder) throw new Error(`No folder named '${name}'`);
    const ids = this.idsIn(name);
    this.folders.delete(name);
    for (const id of ids) this.folderOfProp.delete(id);
    this.dirty = true;
    if (folder.hidden && ids.length) await codewalker.setVisibility(ids, true);
  }

  // Moves props into a folder (created if needed), or to the top level with folder = null. Props
  // take on the visibility of a hidden destination folder.
  async assign(ids: number[], folder: string | null) {
    this.dirty = true;
    if (folder === null) {
      for (const id of ids) this.folderOfProp.delete(id);
      return;
    }
    const name = this.createFolder(folder);
    for (const id of ids) this.folderOfProp.set(id, name);
    if (this.folders.get(name)!.hidden && ids.length) await codewalker.setVisibility(ids, false);
  }

  async setFolderHidden(name: string, hidden: boolean) {
    const folder = this.folders.get(name);
    if (!folder) throw new Error(`No folder named '${name}'`);
    folder.hidden = hidden;
    this.dirty = true;
    const ids = this.idsIn(name);
    if (ids.length) await codewalker.setVisibility(ids, !hidden);
  }

  // Hides or shows single props; saved with the layout.
  async setPropsHidden(ids: number[], hidden: boolean) {
    this.dirty = true;
    await codewalker.setVisibility(ids, !hidden);
  }

  private idsIn(name: string) {
    return [...this.folderOfProp].filter(([, folder]) => folder === name).map(([id]) => id);
  }

  // ---------- persistence ----------

  async save(ymapPath: string) {
    const props = await this.props();
    const byFolder = new Map<string, number[]>();
    for (const p of props) {
      if (p.folder && p.index >= 0) byFolder.set(p.folder, [...(byFolder.get(p.folder) ?? []), p.index]);
    }
    const file: LayoutFile = {
      version: 1,
      folders: this.listFolders().map((f) => ({ ...f, indices: byFolder.get(f.name) ?? [] })),
      hiddenIndices: props.filter((p) => p.hidden && p.index >= 0).map((p) => p.index),
    };
    fs.writeFileSync(layoutPathFor(ymapPath), JSON.stringify(file, null, 2));
    this.dirty = false;
  }

  // Call right after the ymap was opened, while prop indexes still match the saved file.
  async load(ymapPath: string) {
    this.reset();
    const path = layoutPathFor(ymapPath);
    if (!fs.existsSync(path)) return;
    const file = JSON.parse(fs.readFileSync(path, "utf8")) as LayoutFile;
    const props = await codewalker.listProps();
    const idAt = new Map(props.map((p) => [p.index, p.id]));
    const toIds = (indices: number[]) => indices.map((i) => idAt.get(i)).filter((id): id is number => id !== undefined);

    for (const folder of file.folders ?? []) {
      this.folders.set(folder.name, { hidden: false });
      for (const id of toIds(folder.indices)) this.folderOfProp.set(id, folder.name);
    }
    const hidden = toIds(file.hiddenIndices ?? []);
    if (hidden.length) await codewalker.setVisibility(hidden, false);
    for (const folder of file.folders ?? []) {
      if (folder.hidden) this.folders.get(folder.name)!.hidden = true;
    }
  }
}

export const layout = new SceneLayout();
