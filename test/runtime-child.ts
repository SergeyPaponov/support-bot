// IPC only belongs to this test harness, never to the runtime image.
import { startRuntime } from '../src/runtime.js';
const server = startRuntime();
server?.once('listening', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ port: address.port });
});
