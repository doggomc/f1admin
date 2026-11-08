'use strict';

/* Isolated V8 worker for resolving PPV (taifood-blog.asia) stream URLs via
   their own gasm.js + gasm.wasm WebAssembly module without a headless browser
   and without polluting the main Express process's globals. */

const { parentPort } = require('worker_threads');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MODULE_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;

const OrigRequest = globalThis.Request;
const OrigFetch = globalThis.fetch;

let currentEmbedUrl = new URL('https://taifood-blog.asia/embed/init');
let capturedStreamUrl = null;

class BrowserRequest extends OrigRequest {
  constructor(input, init) {
    if (typeof input === 'string' && input.startsWith('/')) {
      input = `${currentEmbedUrl.origin}${input}`;
    }
    super(input, init);
  }
}

class FakeWindow {}
class FakeDocument {}

const locProxy = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'toString') return () => currentEmbedUrl.href;
    const val = currentEmbedUrl[prop];
    return typeof val === 'function' ? val.bind(currentEmbedUrl) : val;
  }
});

function makeFakeElement(tagName, id = '') {
  return {
    id,
    tagName: String(tagName || 'div').toUpperCase(),
    style: {},
    setAttribute() {},
    getAttribute() { return null; },
    appendChild() {},
    removeChild() {},
    insertAdjacentHTML() {},
    addEventListener() {},
    removeEventListener() {},
    getContext() { return null; },
    toDataURL() { return 'data:image/png;base64,AA=='; }
  };
}

const docObj = Object.setPrototypeOf({
  location: locProxy,
  get URL() { return currentEmbedUrl.href; },
  get domain() { return currentEmbedUrl.hostname; },
  referrer: 'https://ppv.to/',
  body: makeFakeElement('body'),
  head: makeFakeElement('head'),
  documentElement: makeFakeElement('html'),
  getElementById(id) { return makeFakeElement('div', id); },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement(tag) { return makeFakeElement(tag); }
}, FakeDocument.prototype);

async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    return await OrigFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function browserFetch(input, init) {
  let url = typeof input === 'string' ? input : input?.url;
  if (url && url.startsWith('/')) url = `${currentEmbedUrl.origin}${url}`;
  const hdrs = new Headers(init?.headers || (input instanceof OrigRequest ? input.headers : undefined));
  hdrs.set('Origin', currentEmbedUrl.origin);
  hdrs.set('Referer', currentEmbedUrl.href);
  hdrs.set('User-Agent', UA);
  if (input instanceof OrigRequest) {
    return input.arrayBuffer().then((ab) => fetchWithTimeout(url, {
      method: input.method,
      headers: hdrs,
      body: ab.byteLength ? Buffer.from(ab) : undefined
    }));
  }
  return fetchWithTimeout(url, {
    method: init?.method || 'GET',
    headers: hdrs,
    body: init?.body
  });
}
Object.defineProperty(browserFetch, 'toString', {
  value: () => 'function fetch() { [native code] }',
  configurable: true
});

const winObj = Object.setPrototypeOf({
  location: locProxy,
  document: docObj,
  navigator: {
    userAgent: UA,
    language: 'en-US',
    languages: ['en-US', 'en'],
    hardwareConcurrency: 4,
    maxTouchPoints: 0
  },
  P2PEngineHls: {
    tryRegisterServiceWorker: () => Promise.resolve(),
    isSupported: () => false
  },
  performance: globalThis.performance,
  crypto: globalThis.crypto,
  queueMicrotask: globalThis.queueMicrotask,
  setTimeout(fn, ms, ...args) {
    const t = setTimeout(fn, ms, ...args);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  },
  clearTimeout: globalThis.clearTimeout,
  setInterval() { return 0; },
  clearInterval() {},
  Request: BrowserRequest,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  fetch: browserFetch,
  jwplayer() {
    return {
      setup(cfg) {
        const candidate = cfg?.file || cfg?.playlist?.[0]?.file || cfg?.sources?.[0]?.file || null;
        if (typeof candidate === 'string' && candidate) capturedStreamUrl = candidate;
        return this;
      },
      load(playlist) {
        const item = Array.isArray(playlist) ? playlist[0] : playlist;
        const candidate = typeof item === 'string' ? item : item?.file || item?.sources?.[0]?.file || null;
        if (typeof candidate === 'string' && candidate) capturedStreamUrl = candidate;
        return this;
      },
      on() { return this; },
      once() { return this; },
      off() { return this; },
      play() { return this; },
      pause() { return this; },
      setMute() { return this; },
      getState() { return 'idle'; },
      remove() {}
    };
  }
}, FakeWindow.prototype);

globalThis.Window = FakeWindow;
globalThis.Document = FakeDocument;
globalThis.Request = BrowserRequest;
globalThis.window = winObj;
globalThis.self = winObj;
globalThis.document = docObj;
globalThis.jwplayer = winObj.jwplayer.bind(winObj);

const moduleCache = new Map(); // embedOrigin -> { mod, at }

async function getInitializedWasm(embedOrigin, forceRefresh = false) {
  const cached = moduleCache.get(embedOrigin);
  if (!forceRefresh && cached && Date.now() - cached.at < MODULE_TTL_MS) {
    return cached.mod;
  }
  const [jsRes, wasmRes] = await Promise.all([
    fetchWithTimeout(`${embedOrigin}/js/wasm/gasm.js`, {
      headers: { Accept: '*/*', 'User-Agent': UA, Referer: `${embedOrigin}/` }
    }),
    fetchWithTimeout(`${embedOrigin}/js/wasm/gasm.wasm`, {
      headers: { Accept: 'application/wasm,*/*', 'User-Agent': UA, Referer: `${embedOrigin}/` }
    })
  ]);
  if (!jsRes.ok || !wasmRes.ok) {
    throw new Error(`WASM asset fetch failed (${jsRes.status}/${wasmRes.status})`);
  }
  const [jsCode, wasmAb] = await Promise.all([jsRes.text(), wasmRes.arrayBuffer()]);
  const wasmModule = await WebAssembly.compile(wasmAb);
  const dataUrl = `data:text/javascript;base64,${Buffer.from(jsCode, 'utf8').toString('base64')}`;
  const mod = await import(dataUrl);
  await mod.default({ module_or_path: wasmModule });
  if (typeof mod.init_wasm === 'function') mod.init_wasm();
  moduleCache.set(embedOrigin, { mod, at: Date.now() });
  return mod;
}

let queue = Promise.resolve();

function enqueueResolve({ id, embedOrigin, slug, forceRefresh }) {
  queue = queue.then(async () => {
    try {
      currentEmbedUrl = new URL(`${embedOrigin}/embed/${slug}`);
      capturedStreamUrl = null;
      const mod = await getInitializedWasm(embedOrigin, Boolean(forceRefresh));
      await mod.set_stream_jw(slug);
      if (capturedStreamUrl && /^https:\/\/[^/\s]+\/.*\.m3u8(?:\?.*)?$/i.test(capturedStreamUrl)) {
        parentPort.postMessage({ id, ok: true, masterUrl: capturedStreamUrl });
      } else {
        parentPort.postMessage({ id, ok: false, error: 'Stream offline or no HLS URL returned.' });
      }
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
    }
  });
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg && typeof msg === 'object' && msg.id != null) {
      enqueueResolve(msg);
    }
  });
}
