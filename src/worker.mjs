// Cloudflare Workers entry — same app as local.mjs, deployed at the edge.
import { createApp } from './app.mjs';

const app = createApp({ withPayment: true });

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
};
