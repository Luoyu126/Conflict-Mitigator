import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPositionedNodes, getMapViewport } from '../../lib/ui/mind-map-layout.ts';
const node = (id, parentNodeId = null) => ({ id, parentNodeId, topic: id });

test('positions every independent root exactly once without inventing relationships', () => {
  const input = Array.from({ length: 6 }, (_, i) => node(`root-${i}`));
  const before = structuredClone(input), result = buildPositionedNodes(input);
  assert.deepEqual(input, before);
  assert.equal(result.length, 6);
  assert.equal(new Set(result.map(p => `${p.x},${p.y}`)).size, 6);
  assert.ok(result.every(p => p.depth === 0 && p.node.parentNodeId === null));
});

test('preserves all trees and arbitrarily deep descendants within the fitted viewport', () => {
  const input = [node('a'), node('b'), node('a1', 'a'), node('a2', 'a'), node('a11', 'a1'), node('a111', 'a11'), node('a1111', 'a111'), node('b1', 'b')];
  const result = buildPositionedNodes(input), positions = new Map(result.map(p => [p.node.id, p]));
  assert.equal(result.length, input.length);
  assert.equal(new Set(result.map(p => `${p.x},${p.y}`)).size, input.length);
  for (const p of result) if (p.node.parentNodeId) {
    const parent = positions.get(p.node.parentNodeId);
    assert.equal(p.depth, parent.depth + 1);
    assert.ok(p.x > parent.x);
  }
  const view = getMapViewport(result);
  for (const p of result) {
    assert.ok(p.x - 150 >= view.x && p.x + 200 <= view.x + view.width);
    assert.ok(p.y - 100 >= view.y && p.y + 110 <= view.y + view.height);
  }
});

test('empty, missing-parent and cyclic snapshots remain finite without dropping nodes', () => {
  assert.deepEqual(buildPositionedNodes([]), []);
  assert.deepEqual(getMapViewport([]), { x: 0, y: 0, width: 1200, height: 760 });
  const input = [node('orphan', 'missing'), node('a', 'b'), node('b', 'a')];
  const result = buildPositionedNodes(input);
  assert.equal(new Set(result.map(p => p.node.id)).size, input.length);
  assert.equal(result.find(p => p.node.id === 'orphan').node.parentNodeId, 'missing');
});
