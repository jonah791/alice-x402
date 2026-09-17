// Local runner: node src/local.mjs   (port 4021)
import { serve } from '@hono/node-server';
import { createApp, CONFIG } from './app.mjs';

// Local dev: route outbound (facilitator) through the tunnel. Without this the process has no DNS.
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (PROXY) {
  const { ProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new ProxyAgent(PROXY));
  console.log('outbound proxy:', PROXY);
}

const port = Number(process.env.PORT || 4021);
const withPayment = process.env.NO_PAYMENT !== '1';
serve({ fetch: createApp({ withPayment }).fetch, port }, (info) => {
  console.log(`alice-x402 listening on http://127.0.0.1:${info.port}`);
  console.log('config:', JSON.stringify(CONFIG));
  console.log('payment middleware:', withPayment ? 'ON' : 'OFF (NO_PAYMENT=1)');
});
