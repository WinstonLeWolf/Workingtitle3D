// Where projects live: one home folder, picked once, with projects/<name>/ inside.
// A page cannot see the folder it was opened from, so the home is picked on first launch
// and its handle remembered (IndexedDB holds the handle only, never model data).
// Later launches need at most one "Allow" click.

const DB = 'workingtitle3d', STORE = 'handles';

function idb(mode, fn) {
  return new Promise((res, rej) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => rej(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => { open.result.close(); res(req?.result); };
      tx.onerror = () => { open.result.close(); rej(tx.error); };
    };
  });
}
export const remember = (key, value) => idb('readwrite', s => s.put(value, key));
export const recall = key => idb('readonly', s => s.get(key)).catch(() => null);

/** The remembered home folder and whether it may be used without asking. */
export async function savedHome() {
  const home = await recall('home');
  if (!home) return { home: null, state: 'none' };
  let state = 'prompt';
  try { state = await home.queryPermission({ mode: 'readwrite' }); } catch { state = 'prompt'; }
  return { home, state };
}

/** Ask again for a remembered folder (needs a click). */
export async function allow(home) {
  return (await home.requestPermission({ mode: 'readwrite' })) === 'granted';
}

/** Pick the home folder (needs a click), make projects/ in it, remember it. */
export async function pickHome() {
  const home = await window.showDirectoryPicker({ id: 'wt3d-home', mode: 'readwrite' });
  await home.getDirectoryHandle('projects', { create: true });
  await remember('home', home);
  return home;
}

export const projectsDir = home => home.getDirectoryHandle('projects', { create: true });

/** Project folders under projects/, newest name order. */
export async function listProjects(home) {
  const dir = await projectsDir(home);
  const out = [];
  for await (const [name, h] of dir.entries()) if (h.kind === 'directory') out.push(name);
  return out.sort((a, b) => a.localeCompare(b));
}

/** Folder names: keep them plain so they work on every system. */
export function cleanName(s) {
  return s.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').slice(0, 80);
}

export async function projectFolder(home, name, create = false) {
  return (await projectsDir(home)).getDirectoryHandle(name, { create });
}
