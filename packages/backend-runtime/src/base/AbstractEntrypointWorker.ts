// Minimal Workers-compatible context type so backend-runtime (Layer 1)
// typechecks without @cloudflare/workers-types. Apps pass the real
// ExecutionContext, which satisfies this structurally.
interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

abstract class AbstractEntrypointWorker {
  public async fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response> {
    try {
      return await this.onRequest(request, env, ctx);
    } catch (err: unknown) {
      console.error('Unhandled error in fetch():', err);
      return new Response('Internal Error', { status: 500 });
    }
  }

  protected abstract onRequest(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response>;
}

export { AbstractEntrypointWorker };
export type { WorkerExecutionContext };
