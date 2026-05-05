/**
 * Registry client adapter — reads ~/awsc-new/awesome/b3x-client-registry/clients.json
 * directly from disk, with mtime-based auto-refresh (no daemons, no polling).
 *
 * Match strategy for zoom config → registry:
 *   1. by proofhub_project_id (ph_project_id-first; ~57% coverage)
 *   2. fall back to slug equality (~30% via slug, ~59% combined)
 */

import { statSync, readFileSync } from 'fs';

const REGISTRY_PATH = process.env.REGISTRY_CLIENTS_JSON
  || '/home/ubuntu/awsc-new/awesome/b3x-client-registry/clients.json';

let _state = {
  clients: [],
  byPh: new Map(),
  bySlug: new Map(),
  mtime: 0,
  loaded: false,
};

export function loadRegistry() {
  try {
    const stat = statSync(REGISTRY_PATH);
    if (stat.mtimeMs === _state.mtime && _state.loaded) return _state;
    const raw = readFileSync(REGISTRY_PATH, 'utf8');
    const doc = JSON.parse(raw);
    const clients = Array.isArray(doc) ? doc : (doc.clients || []);
    const byPh = new Map();
    const bySlug = new Map();
    for (const c of clients) {
      if (c && c.proofhub_project_id) byPh.set(String(c.proofhub_project_id), c);
      if (c && c.slug) bySlug.set(c.slug, c);
    }
    _state = { clients, byPh, bySlug, mtime: stat.mtimeMs, loaded: true };
    return _state;
  } catch (err) {
    // File missing or unreadable — fall back gracefully.
    if (!_state.loaded) {
      console.warn('[registry-client] failed to load:', err.message);
      _state = { clients: [], byPh: new Map(), bySlug: new Map(), mtime: 0, loaded: false };
    }
    return _state;
  }
}

/**
 * @param {{id?: string, name?: string, ph_project_id?: string}} zoomClient
 * @returns {null | { status: string, slug: string, name: string }}
 */
export function getStatusForZoomClient(zoomClient) {
  if (!zoomClient) return null;
  const s = loadRegistry();
  if (!s.loaded) return null;
  if (zoomClient.ph_project_id) {
    const r = s.byPh.get(String(zoomClient.ph_project_id));
    if (r) return { status: r.status, slug: r.slug, name: r.name };
  }
  if (zoomClient.id) {
    const r = s.bySlug.get(zoomClient.id);
    if (r) return { status: r.status, slug: r.slug, name: r.name };
  }
  return null;
}

export function getAllRegistryClients() {
  return loadRegistry().clients;
}
