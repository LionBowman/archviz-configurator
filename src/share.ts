import type { Viewer } from './viewer';
import type { PresetsApi, Preset } from './presets';
import type { UI } from './ui';
import { fields, setField } from './controls';

/**
 * Share links: the whole view (camera, lighting, environment, post, materials, model) is compressed into the
 * URL hash, so a link works on any static host with no server or storage:
 *   https://host/app/#v=<deflate+base64url JSON>            full app, opened in that state
 *   https://host/app/#v=<…>&mode=viewer                     clean client view: no settings panel
 * The hash never reaches the server, so links don't show up in host logs.
 */

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function encodeState(p: Preset): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ ...p, savedAt: undefined, name: undefined }));
  if (typeof CompressionStream === 'undefined') return `j${b64url(json)}`;
  return `z${b64url(await pipe(json, new CompressionStream('deflate-raw')))}`;
}

export async function decodeState(s: string): Promise<Preset | null> {
  try {
    const raw = fromB64url(s.slice(1));
    const json = s[0] === 'z' ? await pipe(raw, new DecompressionStream('deflate-raw')) : raw;
    const p = JSON.parse(new TextDecoder().decode(json));
    return p && typeof p === 'object' && p.scene ? { ...p, name: 'Shared view', savedAt: '' } : null;
  } catch { return null; }
}

function parseHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { state: h.get('v'), viewer: h.get('mode') === 'viewer' };
}

const ICON_SHARE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg>';
const ICON_ROTATE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>';

export function setupShare(viewer: Viewer, ui: UI, presets: PresetsApi, isWalking: () => boolean) {
  // ------------------------------------------------------------ rotate button (synced with Camera → auto rotate)
  const dock = document.createElement('div');
  dock.className = 'fab-dock';
  const rotate = document.createElement('button');
  rotate.className = 'fab';
  rotate.title = 'Auto-rotate';
  rotate.setAttribute('aria-label', 'Toggle auto-rotate');
  rotate.innerHTML = ICON_ROTATE;
  const syncRotate = () => rotate.classList.toggle('active', viewer.controls.autoRotate);
  rotate.addEventListener('click', () => {
    if (isWalking()) { presets.flash('Leave “walk inside” to auto-rotate'); return; }
    const f = fields.get('Camera/autoRotate');
    if (f) setField(f, !viewer.controls.autoRotate); else viewer.controls.autoRotate = !viewer.controls.autoRotate;
    viewer.changed();
    syncRotate();
  });
  viewer.listeners.changed.add(syncRotate);

  const share = document.createElement('button');
  share.className = 'fab';
  share.title = 'Share this view';
  share.setAttribute('aria-label', 'Share this view');
  share.innerHTML = ICON_SHARE;
  share.addEventListener('click', () => void shareLink(document.body.classList.contains('viewer-mode')));
  dock.append(share, rotate);
  document.body.appendChild(dock);
  syncRotate();

  // ------------------------------------------------------------ links
  const makeLink = async (viewerOnly: boolean) => {
    const state = await encodeState(presets.capture('share', true));
    const url = new URL(location.href);
    url.hash = `v=${state}${viewerOnly ? '&mode=viewer' : ''}`;
    return url.toString();
  };

  const isLocal = () => /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname);

  async function shareLink(viewerOnly: boolean) {
    const link = await makeLink(viewerOnly);
    const note = isLocal() ? ' (this address only works on this computer: host the app to share it, see README)' : '';
    // Native share sheet on phones/tablets; clipboard elsewhere.
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: document.title, url: link }); return; } catch { /* cancelled → fall through */ }
    }
    try {
      await navigator.clipboard.writeText(link);
      presets.flash(`${viewerOnly ? 'Viewer' : 'Share'} link copied${note}`, isLocal() ? 6000 : 2500);
    } catch {
      prompt('Copy this link:', link);
    }
  }

  const P = ui.sections.Presets;
  (P.addBlade({ view: 'buttongrid', size: [2, 1], cells: (x: number) => ({ title: ['Copy share link', 'Copy viewer link'][x] }), label: 'share' } as any) as any)
    .on('click', (e: { index: [number, number] }) => void shareLink(e.index[0] === 1));

  // ------------------------------------------------------------ open a shared link
  const { state, viewer: viewerMode } = parseHash();
  if (viewerMode) {
    document.body.classList.add('viewer-mode');
    ui.close();
  }
  if (state) {
    void decodeState(state).then(async (p) => {
      if (!p) { presets.flash('That share link is damaged or incomplete'); return; }
      await presets.apply(p);
      // Clean the address bar: the state now lives in the app, and edits shouldn't look like the shared link.
      if (!viewerMode) history.replaceState(null, '', location.pathname + location.search);
    });
  }
}
