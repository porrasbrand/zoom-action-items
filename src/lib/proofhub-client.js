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
async function request(method, path, data = null) {
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
    'X-API-KEY': process.env.PROOFHUB_API_KEY,
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
 * Create a task
 */
export async function createTask(projectId, taskListId, taskData) {
  return request('POST', `/projects/${projectId}/todolists/${taskListId}/tasks`, taskData);
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

export default {
  isProofhubConfigured,
  clearCache,
  getProjects,
  getTaskLists,
  getTasks,
  getAllProjectTasks,
  createTask,
  getTask,
  getPeople
};
