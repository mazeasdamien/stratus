/** Stands in for cloudflare:workers: only the base class src/index.js extends. */
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
