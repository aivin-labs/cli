import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChoiceInput } from '../bin/lib/remote/missionQuestion.mjs';

const options = [{ id: 'approve', text: 'Cho phép' }, { id: 'reject', text: 'Không cho phép' }, { id: 'c', text: 'C' }];

test('chọn một: số thứ tự → id, số lạ / nhiều số / rỗng → hỏi lại', () => {
  assert.deepEqual(parseChoiceInput('1', options, false), ['approve']);
  assert.deepEqual(parseChoiceInput(' 2 ', options, false), ['reject']);
  assert.equal(parseChoiceInput('4', options, false), undefined);
  assert.equal(parseChoiceInput('0', options, false), undefined);
  assert.equal(parseChoiceInput('1,2', options, false), undefined);
  assert.equal(parseChoiceInput('', options, false), undefined);
  assert.equal(parseChoiceInput('y', options, false), undefined);
});

test('chọn nhiều: dấu phẩy / cách, bỏ trùng', () => {
  assert.deepEqual(parseChoiceInput('3, 1 3', options, true), ['c', 'approve']);
});
