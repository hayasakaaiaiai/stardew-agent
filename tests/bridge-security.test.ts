import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { connect, harness } from './helpers/bridge.ts';

test('browser origins cannot access the native game bridge, while the Mod connection still works', { timeout: 10_000 }, async t => {
  const environment = await harness(t);
  const server = await environment.start();
  for (const origin of ['https://example.invalid', 'http://127.0.0.1:8000', 'null']) {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin });
    const outcome = await new Promise<'opened' | Error>(resolve => {
      socket.once('open', () => resolve('opened'));
      socket.once('error', resolve);
    });
    socket.close();
    assert.ok(outcome instanceof Error && /Unexpected server response: 401/.test(outcome.message),
      `Unexpected access for origin ${origin}: ${outcome instanceof Error ? outcome.message : outcome}`);
  }
  const native = await connect(server);
  assert.ok(native.inbox.some(message => message.type === 'save.ready'));
  await native.close();
  assert.equal(environment.fake.sent.length, 0);
});
