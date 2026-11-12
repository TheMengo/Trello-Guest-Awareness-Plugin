import {test} from 'node:test';
import assert from 'node:assert/strict';
import {route} from '../src/dom';
test('extracts board and card refs without reading page state',()=>{
  assert.deepEqual(route('/b/AbCd1234/project'),{boardRef:'AbCd1234'});
  assert.deepEqual(route('/c/CaRd1234/name'),{cardRef:'CaRd1234'});
  assert.deepEqual(route('/b/0123456789abcdef01234567'),{boardRef:'0123456789abcdef01234567'});
  for(const path of ['/', '/c/short/name', '/x/AbCd1234', '/c/AbCd1234evil']) assert.equal(route(path),null);
});
