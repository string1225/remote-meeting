import { createMeetingServer } from './app.js';

const server = createMeetingServer();
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(`Remote Meeting signaling listening on ${process.env.HOST || '127.0.0.1'}:${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.shutdown().then(() => process.exit(0)));
}
