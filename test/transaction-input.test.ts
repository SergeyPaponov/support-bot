import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transactionAnalysisInput, transactionSearchWindow } from '../src/contracts.js';

test('transaction-only input accepts exactly one valid transaction_id field', () => {
  assert.deepEqual(transactionAnalysisInput.parse({ transaction_id: 'abc-123-xyz' }), { transaction_id: 'abc-123-xyz' });
  for (const value of [undefined, null, [], {}, { transaction_id: '' }, { transaction_id: '  ' },
    { transaction_id: 123 }, { transaction_id: 'a" | delete' }, { transaction_id: 'x'.repeat(129) },
    { transaction_id: 'abc', apiId: 'payments' }, { transaction_id: 'abc', from: '2026-11-01T00:00:00Z' },
    { transaction_id: 'abc', to: '2026-11-19T00:00:00Z' }, { transactionId: 'abc' }]) {
    assert.equal(transactionAnalysisInput.safeParse(value).success, false);
  }
});

test('transaction search is exactly fourteen elapsed days in UTC including milliseconds', () => {
  for (const iso of ['2026-11-19T12:34:56.789Z', '2026-03-30T00:00:00.123+03:00', '2024-03-01T00:00:00.000Z']) {
    const now = new Date(iso);
    const window = transactionSearchWindow(now);
    assert.equal(window.to, now.toISOString());
    assert.equal(Date.parse(window.to) - Date.parse(window.from), 14 * 24 * 60 * 60 * 1000);
    assert.ok(window.from.endsWith('Z') && window.to.endsWith('Z'));
  }
});
