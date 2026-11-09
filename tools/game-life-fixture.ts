/** Explicitly clear unrelated vanilla cutscenes before placing actors in the disposable test world. */
import assert from 'node:assert/strict';
import type { State } from './test-game-world.ts';

interface FixtureHost {
  rpc(operation: string, args?: Record<string, unknown>): Promise<State>;
  evidence(label: string, data: unknown): Promise<void>;
}

export async function stageLife(h: FixtureHost, args: Record<string, unknown>) {
  let state = await h.rpc('life-setup', args);
  for (let attempt = 0; state.eventUp && attempt < 4; attempt++) {
    await h.evidence('fixture-unrelated-vanilla-cutscene', { event: state.festival, location: state.location });
    await h.rpc('action-event-skip');
    state = await h.rpc('life-setup', args);
  }
  assert.ok(!state.eventUp, 'Unrelated vanilla cutscene still owns the scene; refusing to test life actions.');
  return state;
}
