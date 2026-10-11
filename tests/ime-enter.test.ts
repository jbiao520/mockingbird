import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImeEnterGuard } from '../src/ime-enter';

const flush=()=>new Promise(resolve=>setTimeout(resolve,0));

test('Enter confirms an IME candidate and does not submit the prompt',async()=>{
  const guard=createImeEnterGuard();
  assert.equal(guard.keydown({key:'Enter'}),'send');
  assert.equal(guard.keydown({key:'Enter',shiftKey:true}),'ignore');
  assert.equal(guard.keydown({key:'a'}),'ignore');

  guard.compositionStart();
  assert.equal(guard.keydown({key:'Enter',isComposing:true,keyCode:229}),'ignore');
  assert.equal(guard.keydown({key:'Enter',keyCode:13}),'swallow');

  // Chrome/Electron: compositionend, then a plain Enter with isComposing false.
  guard.compositionEnd();
  assert.equal(guard.keydown({key:'Enter',isComposing:false,keyCode:229}),'ignore');
  assert.equal(guard.keydown({key:'Enter',isComposing:false,keyCode:13}),'swallow');
  await flush();
  assert.equal(guard.keydown({key:'Enter',keyCode:13}),'send');

  // A new composition cancels the pending release from the previous one.
  guard.compositionEnd();
  guard.compositionStart();
  await flush();
  assert.equal(guard.keydown({key:'Enter'}),'swallow');
  guard.compositionEnd();
  await flush();
  assert.equal(guard.keydown({key:'Enter'}),'send');

  // Leaving the field ends the composition, so the next Enter can send.
  guard.compositionStart();
  guard.blur();
  assert.equal(guard.keydown({key:'Enter'}),'send');
});
