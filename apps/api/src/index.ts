import { DurableDavRouterWorker } from './workers/DurableDavRouterWorker';

const worker = new DurableDavRouterWorker();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => worker.fetch(request, env, ctx),
};
