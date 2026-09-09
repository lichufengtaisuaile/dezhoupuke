import { createPokerServer } from '../server.js';

const port = Number(process.env.PORT ?? 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
const host = process.env.HOST ?? '127.0.0.1';

// A managed service must fail on a busy port instead of silently changing it.
const server = await createPokerServer({ port, host });
console.log(`Dezhou listening on ${host}:${server.port}`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    console.error('Shutdown failed:', error);
    process.exit(1);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
