'use strict';
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { stripWeellzHtml } = require('../stream-resolver');
const html = stripWeellzHtml('<!doctype html><html><head></head><body></body></html>');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function scenario(query) {
  const dom = new JSDOM(html, { url: `https://f1admin.example/api/stream/weellz-embed?stream=test&${query}`, runScripts: 'dangerously' });
  const video = dom.window.document.createElement('video');
  Object.defineProperty(video, 'readyState', { value: 2, configurable: true });
  let count = 0;
  video.play = () => { count++; return Promise.resolve(); };
  dom.window.document.body.appendChild(video);
  await tick();
  return { dom, video, calls: () => count };
}
(async () => {
  const muted = await scenario('autoplay=1&mute=1');
  assert.equal(muted.calls(), 1, 'secondary video starts as soon as playable');
  assert.equal(muted.video.muted, true);
  assert.ok(muted.video.hasAttribute('playsinline'));
  muted.video.dispatchEvent(new muted.dom.window.Event('playing'));
  muted.video.dispatchEvent(new muted.dom.window.Event('canplay'));
  assert.equal(muted.calls(), 1, 'never restart a video after playback begins');
  muted.dom.window.close();
  const unmuted = await scenario('autoplay=1&mute=0');
  assert.equal(unmuted.calls(), 0, 'do not force unmuted playback');
  assert.equal(unmuted.video.muted, false);
  unmuted.dom.window.close();
  const normal = await scenario('mute=1');
  assert.equal(normal.calls(), 0, 'leave non-multiviewer players alone');
  normal.dom.window.close();
  console.log('weellz autoplay: muted start, manual pause safety and scoped activation passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
