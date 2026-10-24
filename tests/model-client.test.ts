import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { modelConfigFromEnv } from '../src/services/model/client.ts';

const required = { NPC_MODEL_ENDPOINT: 'https://example.invalid/v1', NPC_MODEL_NAME: 'test-model', NPC_MODEL_API_KEY: 'test-key' };

test('a copied env example uses the documented limits when optional fields are empty', async () => {
  const example = parseEnv(await readFile(new URL('../.env.example', import.meta.url), 'utf8'));
  const config = modelConfigFromEnv({ ...example, ...required });
  assert.equal(config.timeoutMs, 60_000);
  assert.equal(config.maxTokens, 4000);
  assert.equal(config.thinking, 'high');
  assert.equal(modelConfigFromEnv({ ...required, NPC_MODEL_TIMEOUT_MS: '  ', NPC_MODEL_MAX_TOKENS: '  ' }).timeoutMs, 60_000);
  const custom = modelConfigFromEnv({ ...required, NPC_MODEL_TIMEOUT_MS: '120000', NPC_MODEL_MAX_TOKENS: '8000' });
  assert.equal(custom.timeoutMs, 120_000);
  assert.equal(custom.maxTokens, 8000);
});

test('invalid model limits fail at configuration instead of failing a later game request', () => {
  for (const name of ['NPC_MODEL_TIMEOUT_MS', 'NPC_MODEL_MAX_TOKENS']) {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', 'not-a-number']) {
      assert.throws(() => modelConfigFromEnv({ ...required, [name]: value }), new RegExp(name));
    }
  }
});
