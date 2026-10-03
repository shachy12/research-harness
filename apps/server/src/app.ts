import type { Effort, ModelsResponse } from '@harness/shared';
import { Hono } from 'hono';
import type { Repository } from './db/repository.ts';
import type { LLMProvider, ModelCatalog } from './llm/index.ts';
import { classifyError } from './llm/errors.ts';
import { HttpError } from './routes/errors.ts';
import { nodeRoutes } from './routes/nodes.ts';
import { projectRoutes } from './routes/projects.ts';
import { RunManager } from './runs.ts';
import { systemRoutes } from './routes/system.ts';
import { pickFolder } from './system/folder-picker.ts';
import { HarnessTools, harnessMcpRoutes } from './tools/harness.ts';
import type { Workspaces } from './workspace.ts';
import { Worktrees } from './worktrees.ts';

export interface AppDeps {
  repo: Repository;
  llm: LLMProvider;
  workspaces: Workspaces;
  /** Back up the database (e.g. before "Start over"); returns the backup's path. Absent in tests. */
  backup?: (label: string) => string;
  /** Show the OS folder dialog (tests pass a fake). */
  pickFolder?: typeof pickFolder;
  /**
   * Where this server can be reached from the same machine, e.g. http://127.0.0.1:8787. The model's
   * CLI connects to the harness MCP server there; without it, nodes get no harness tools.
   */
  serverUrl?: string;
  /** ask_node questions one user message allows before the user must approve more (default 3). */
  askLimit?: number;
  /** How long questions wait for approval before they count as unanswered (tests shorten it). */
  askApprovalTimeoutMs?: number;
}

export interface RouteDeps extends AppDeps {
  runs: RunManager;
  worktrees: Worktrees;
  pickFolder: typeof pickFolder;
  /** Throws a 400 unless the provider offers this model and the model takes this effort (null: default). */
  checkModel: (model: string | null, effort: Effort | null) => Promise<void>;
  /** The provider's model list and defaults, or a 502 the UI can show. */
  loadModels: () => Promise<ModelCatalog>;
}

/** The provider's model list, or a 502 the UI can show if it can't be loaded. */
async function loadModels(llm: LLMProvider) {
  try {
    return await llm.models();
  } catch (err) {
    console.error('[models]', err);
    throw new HttpError(502, `Could not load the model list: ${classifyError(err).message}`);
  }
}

function modelChecker(llm: LLMProvider): RouteDeps['checkModel'] {
  return async (model, effort) => {
    if (model === null && effort === null) return;
    const catalog = await loadModels(llm);
    const id = model ?? catalog.defaultModel;
    const option = catalog.models.find((m) => m.id === id);
    if (model !== null && !option) throw new HttpError(400, `Unknown model "${model}".`);
    if (effort !== null && option && !option.efforts.includes(effort)) {
      throw new HttpError(400, option.efforts.length ? `${option.id} takes effort ${option.efforts.join(', ')}.` : `${option.id} has no effort setting.`);
    }
  };
}

// Dependencies are passed in, so tests can use an in-memory database and a fake model.
export function createApp(deps: AppDeps) {
  const worktrees = new Worktrees(deps.workspaces);
  // `chargeTo`: a node asked by another node's reply; its own questions count against that reply.
  const mcpUrl = (nodeId: string, chargeTo?: string) => {
    if (!deps.serverUrl) return null;
    const url = `${deps.serverUrl}/api/mcp/${nodeId}`;
    return chargeTo && chargeTo !== nodeId ? `${url}?for=${chargeTo}` : url;
  };
  const runs = new RunManager(deps.repo, deps.llm, deps.workspaces, worktrees, {
    mcpUrl,
    askLimit: deps.askLimit,
    approvalTimeoutMs: deps.askApprovalTimeoutMs,
  });
  const tools = new HarnessTools({ repo: deps.repo, llm: deps.llm, runs, workspaces: deps.workspaces, mcpUrl });
  const routeDeps: RouteDeps = {
    ...deps,
    worktrees,
    runs,
    pickFolder: deps.pickFolder ?? pickFolder,
    checkModel: modelChecker(deps.llm),
    loadModels: () => loadModels(deps.llm),
  };
  return new Hono()
    .basePath('/api')
    .onError((err, c) => {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
      console.error(err);
      return c.json({ error: 'Something went wrong on the server' }, 500);
    })
    .get('/health', (c) => c.json({ ok: true, model: deps.llm.label }))
    .get('/models', async (c) => c.json<ModelsResponse>({ provider: deps.llm.kind, canEdit: deps.llm.canEdit, ...(await loadModels(deps.llm)) }))
    .route('/projects', projectRoutes(routeDeps))
    .route('/nodes', nodeRoutes(routeDeps))
    .route('/system', systemRoutes(routeDeps))
    .route('/mcp', harnessMcpRoutes(tools, (id) => deps.repo.getNode(id) !== null));
}

export type AppType = ReturnType<typeof createApp>;
