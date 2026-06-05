/**
 * Proofhub API Client
 * REST client with rate limiting and caching
 */

let lastRequestTime = 0;
const MIN_INTERVAL = 400; // 25 req/10s = 1 req/400ms
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Check if ProofHub is configured
 */
export function isProofhubConfigured() {
  return !!(process.env.PROOFHUB_API_KEY && process.env.PROOFHUB_COMPANY_URL);
}

/**
 * Rate-limited request to Proofhub API
 */
async function request(method, path, data = null, apiKey = null) {
  if (!isProofhubConfigured()) {
    throw new Error('ProofHub not configured (PROOFHUB_API_KEY, PROOFHUB_COMPANY_URL required)');
  }

  // Rate limiting
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL - elapsed));
  }
  lastRequestTime = Date.now();

  const baseUrl = `https://${process.env.PROOFHUB_COMPANY_URL}/api/v3`;
  const url = `${baseUrl}${path}`;

  const headers = {
    'X-API-KEY': apiKey || process.env.PROOFHUB_API_KEY,
    'User-Agent': 'ZoomPipeline/1.0 (porrasbrand@gmail.com)',
    'Content-Type': 'application/json'
  };

  const options = {
    method,
    headers
  };

  if (data) {
    options.body = JSON.stringify(data);
  }

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ProofHub API ${method} ${path} failed: ${response.status} ${errorText}`);
    }

    return await response.json();
  } catch (err) {
    console.error('ProofHub API error:', { method, path, error: err.message });
    throw err;
  }
}

/**
 * Get from cache or fetch
 */
async function getCached(key, fetchFn) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const data = await fetchFn();
  cache.set(key, { data, timestamp: Date.now() });
  return data;
}

/**
 * Clear the cache
 */
export function clearCache() {
  cache.clear();
}

/**
 * Get all projects
 */
export async function getProjects(useCache = true) {
  if (useCache) {
    return getCached('projects', () => request('GET', '/projects'));
  }
  return request('GET', '/projects');
}

/**
 * Get task lists for a project
 */
export async function getTaskLists(projectId, useCache = true) {
  const key = `tasklists_${projectId}`;
  if (useCache) {
    return getCached(key, () => request('GET', `/projects/${projectId}/todolists`));
  }
  return request('GET', `/projects/${projectId}/todolists`);
}

/**
 * Get tasks for a task list
 */
export async function getTasks(projectId, taskListId) {
  return request('GET', `/projects/${projectId}/todolists/${taskListId}/tasks`);
}

/**
 * Get all tasks for a project (across all task lists)
 */
export async function getAllProjectTasks(projectId) {
  const taskLists = await getTaskLists(projectId);
  const allTasks = [];

  for (const list of taskLists) {
    try {
      const tasks = await getTasks(projectId, list.id);
      for (const task of tasks) {
        task._taskListId = list.id;
        task._taskListTitle = list.title;
      }
      allTasks.push(...tasks);
    } catch (err) {
      console.warn('Failed to fetch tasks for list:', {
        projectId,
        taskListId: list.id,
        error: err.message
      });
    }
  }

  return allTasks;
}

/**
 * Create a task. Pass `apiKey` to author the task as that user (per-user key);
 * omit it to fall back to the shared PROOFHUB_API_KEY env var.
 */
export async function createTask(projectId, taskListId, taskData, apiKey = null) {
  return request('POST', `/projects/${projectId}/todolists/${taskListId}/tasks`, taskData, apiKey);
}

/**
 * Get a single task
 */
export async function getTask(projectId, taskListId, taskId) {
  return request('GET', `/projects/${projectId}/todolists/${taskListId}/tasks/${taskId}`);
}

/**
 * Get people
 */
export async function getPeople() {
  return request('GET', '/people');
}

/**
 * Get comments for a task
 */
export async function getTaskComments(projectId, taskListId, taskId) {
  return request('GET', `/projects/${projectId}/todolists/${taskListId}/tasks/${taskId}/comments`);
}

/**
 * Upload a file and attach it to a task in ProofHub at the TASK level
 * (same place the PH UI 'Attach files' paperclip button puts files —
 * connected_with='todo_item').
 *
 * Working contract (verified empirically 2026-05-08; prior implementation
 * shipped attachments via comments which the user did not want):
 *
 *   Step 1: POST https://<host>/files/upload.php  (NOT /api/v3/...)
 *           multipart form-data: { project_id, file }
 *           → 200 OK with body {success:true, file_id:<int>}.
 *
 *   Step 2: GET  /api/v3/projects/<pid>/todolists/<tlid>/tasks/<taskId>
 *           → read existing task.attachments to merge against
 *
 *   Step 3: PUT  /api/v3/projects/<pid>/todolists/<tlid>/tasks/<taskId>
 *           JSON body: { attachments: [...existing_ids, new_fileId] }
 *           → returns the task with attachments[] including the new file.
 *
 * Important: PH treats PUT.attachments as REPLACE (not append). We GET
 * the current list first and union our new file_id. Without this, a
 * second push would clobber the first attachment.
 *
 * Validates JSON bodies on every step — never trusts HTTP 200 alone.
 */
export async function uploadFileToTask(projectId, taskListId, taskId, fileBuffer, filename) {
  if (!isProofhubConfigured()) throw new Error('ProofHub not configured');

  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL) await new Promise(r => setTimeout(r, MIN_INTERVAL - elapsed));
  lastRequestTime = Date.now();

  const host = process.env.PROOFHUB_COMPANY_URL;

  // Step 1 — upload to /files/upload.php
  const fd = new FormData();
  fd.append('project_id', String(projectId));
  fd.append('file', new Blob([fileBuffer]), filename || 'attachment.bin');

  const uploadRes = await fetch(`https://${host}/files/upload.php`, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.PROOFHUB_API_KEY,
      'User-Agent': 'ZoomPipeline/1.0',
    },
    body: fd,
  });
  const uploadText = await uploadRes.text();
  let uploadJson;
  try { uploadJson = JSON.parse(uploadText); }
  catch (e) {
    console.error('[PH attach] step1 non-JSON response:', uploadRes.status, uploadText.slice(0, 300));
    throw new Error(`PH file upload returned non-JSON (${uploadRes.status}): ${uploadText.slice(0, 200)}`);
  }
  if (!uploadJson.success || !uploadJson.file_id) {
    console.error('[PH attach] step1 failed:', uploadRes.status, JSON.stringify(uploadJson).slice(0, 400));
    throw new Error(`PH file upload failed (${uploadJson.code || uploadRes.status}): ${uploadJson.message || uploadText.slice(0, 200)}`);
  }
  const fileId = uploadJson.file_id;
  console.log(`[PH attach] step1 OK — uploaded ${filename} (${fileBuffer.length} bytes) → file_id=${fileId}`);

  // Step 2 — read existing task.attachments[] so we don't clobber on PUT
  const taskRes = await request('GET', `/projects/${projectId}/todolists/${taskListId}/tasks/${taskId}`);
  const existingIds = Array.isArray(taskRes?.attachments)
    ? taskRes.attachments.map(a => a && a.id).filter(Boolean)
    : [];
  console.log(`[PH attach] step2 OK — task currently has ${existingIds.length} attachment(s)`);

  // Step 3 — PUT merged list (PH PUT REPLACES the attachments array)
  const merged = [...existingIds, fileId];
  const putRes = await request('PUT', `/projects/${projectId}/todolists/${taskListId}/tasks/${taskId}`, {
    attachments: merged,
  });
  const attached = Array.isArray(putRes?.attachments)
    ? putRes.attachments.find(a => a && a.id === fileId)
    : null;
  if (!attached) {
    console.error('[PH attach] step3 unexpected response:', JSON.stringify(putRes).slice(0, 400));
    throw new Error('PH PUT succeeded but new file_id not present in task.attachments[]');
  }
  console.log(`[PH attach] step3 OK — file_id=${fileId} now at task level (${attached.connected_with || 'todo_item'}); task has ${putRes.attachments.length} attachment(s) total`);

  return {
    fileId,
    attached: true,
    filename,
    size: fileBuffer.length,
    fileUrl: attached.url?.view || attached.url?.download || null,
  };
}

// Pass `apiKey` to author the comment as that user; omit it to fall back to the shared key.
export async function addTaskComment(projectId, taskListId, taskId, content, apiKey = null) {
  return request('POST', `/projects/${projectId}/todolists/${taskListId}/tasks/${taskId}/comments`, {
    description: content
  }, apiKey);
}

/**
 * Format a real ProofHub @-mention. PH only renders a mention pill (and fires
 * the notification) when the comment HTML contains a <phmention> tag with
 * class="mprofile" and a numeric data-id. Production-verified format used by
 * the triage dashboard's AI follow-up flow:
 *
 *   <phmention contenteditable="false" class="mprofile" data-id="12345">First Last </phmention>
 *
 * Note the trailing space inside the tag — PH's web UI emits it and we mirror
 * that to be byte-identical with what the editor produces.
 *
 * @param {{id: string|number, first_name?: string, last_name?: string, name?: string}} user
 * @returns {string} HTML mention; falls back to plain @firstName if user shape is bad.
 */
export function formatMention(user) {
  if (!user || user.id == null) return '';
  const first = (user.first_name || '').trim();
  const last  = (user.last_name  || '').trim();
  const display = (first || last)
    ? `${first}${first && last ? ' ' : ''}${last}`
    : (user.name || '').trim();
  if (!display) return `@user-${user.id}`;
  return `<phmention contenteditable="false" class="mprofile" data-id="${String(user.id)}">${display} </phmention>`;
}

export async function deleteTask(projectId, taskListId, taskId) {
  if (!isProofhubConfigured()) throw new Error('ProofHub not configured');
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL) await new Promise(r => setTimeout(r, MIN_INTERVAL - elapsed));
  lastRequestTime = Date.now();

  const baseUrl = `https://${process.env.PROOFHUB_COMPANY_URL}/api/v3`;
  const url = `${baseUrl}/projects/${projectId}/todolists/${taskListId}/tasks/${taskId}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { 'X-API-KEY': process.env.PROOFHUB_API_KEY, 'User-Agent': 'ZoomPipeline/1.0 (porrasbrand@gmail.com)' }
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`ProofHub DELETE failed: ${response.status}`);
  }
  return { deleted: true, status: response.status };
}

export default {
  isProofhubConfigured,
  clearCache,
  getProjects,
  getTaskLists,
  getTasks,
  getAllProjectTasks,
  createTask,
  getTask,
  getPeople,
  getTaskComments,
  addTaskComment,
  formatMention,
  deleteTask
};
