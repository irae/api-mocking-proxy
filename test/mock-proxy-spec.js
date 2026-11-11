const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { gzipSync, gunzipSync } = require('node:zlib');
const httpMocks = require('node-mocks-http');
const nock = require('nock').default;
const testUtils = require('./test-utils')();
const proxy = require('../lib/mock-proxy').default;
const cache = require('../lib/cache-middleware').default;
const cacher = require('../lib/cacher').default;

describe('mock-proxy', function () {
  let root;
  before(async function () {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'amp-proxy-'));
    cacher.root = root;
    nock.disableNetConnect();
  });
  afterEach(function () {
    const pending = nock.pendingMocks();
    nock.cleanAll();
    assert.deepEqual(pending, []);
  });
  after(async function () {
    nock.enableNetConnect();
    await fs.rm(root, { recursive: true, force: true });
  });

  const cases = [
    ['/hello'],
    ['/greeting/hello'],
    ['/hello?a=b'],
    ['/hello?a=b&c=d'],
    ['/hello/a/b/c/d'],
    ['/hello', { headers: { authorization: '12345' } }],
    ['/hello', { headers: { authorization: '12345', 'access-control-allow-origin': 'http://www.example.com' } }],
    ['/hello?a=b', { headers: { authorization: '12345' } }],
    ['/hello/a/b/c/d', { headers: { authorization: '12345' } }],
    ['/hello', { method: 'POST', body: { a: 'b', c: 'd' } }],
    ['/hello', { method: 'POST', body: { a: 'b', c: 'd' }, headers: { authorization: '12345' } }],
    ['/hello', {
      method: 'POST',
      body: { a: 'b', c: 'd' },
      headers: { authorization: '12345', 'access-control-allow-origin': 'http://www.example.com' }
    }],
    ['/hello', { method: 'PUT', body: { a: 'b', c: 'd' } }],
    ['/hello/a/b/c/d', { method: 'DELETE' }],
    ['/hello', { method: 'PATCH', body: { a: 'b' } }],
    ['/hello', { method: 'OPTIONS' }]
  ];

  for (const [url, options = {}] of cases) {
    describe((options.method || 'GET') + ' ' + url + ' ' + JSON.stringify(options), function () {
      let data;
      it('proxies the request and saves the response', async function () {
        const req = testUtils.mockRequest('mocks', url, options);
        const res = httpMocks.createResponse();
        nock(req.conf.host)
          .intercept(url, req.method, options.body ? req.body.toString() : undefined)
          .reply(200, '{"msg":"hello world"}', { 'content-type': 'application/json' });

        await proxy()(req, res, () => assert.fail('unexpected next'));
        data = await cacher.get(req);
        assert.equal(res.statusCode, 200);
        assert.equal(data.body, '{"msg":"hello world"}');
        assert.equal(res._getData(), data.body);
        assert.equal(res.getHeader('content-type'), data.headers['content-type']);
      });
      it('replays the cached response without an upstream request', async function () {
        const req = testUtils.mockRequest('mocks', url, options);
        const res = httpMocks.createResponse();
        await cache()(req, res, () => assert.fail('cache miss'));
        assert.equal(res.statusCode, data.code);
        assert.equal(res._getData(), data.body);
      });
    });
  }

  it('renders the home and error templates with the current EJS API', async function () {
    const ejs = require('ejs');
    const home = await ejs.renderFile(path.join(__dirname, '../views/index.ejs'), {
      title: 'API Mocking Proxy Server', mappings: [{ key: 'mocks', host: 'http://127.0.0.1:4969' }]
    });
    assert.match(home, /API Mocking Proxy Server/);
    assert.match(home, /\/mocks\/\*/);
    const error = await ejs.renderFile(path.join(__dirname, '../views/error.ejs'), {
      message: 'Test error', error: { status: 500, stack: 'Test stack' }
    });
    assert.match(error, /Test error/);
  });

  it('handles HEAD responses with an empty body', async function () {
    const req = testUtils.mockRequest('mocks', '/head', { method: 'HEAD' });
    const res = httpMocks.createResponse();
    nock(req.conf.host).head('/head').reply(200, '', { 'content-type': 'text/plain' });
    await proxy()(req, res, () => assert.fail());
    assert.equal(res.statusCode, 200);
    assert.equal((await cacher.get(req)).body, '');
  });

  it('passes through and caches non-success status codes', async function () {
    const req = testUtils.mockRequest('mocks', '/missing');
    const res = httpMocks.createResponse();
    nock(req.conf.host).get('/missing').reply(404, 'not found');
    await proxy()(req, res, () => assert.fail());
    assert.equal(res.statusCode, 404);
    assert.equal(res._getData(), 'not found');
    assert.equal((await cacher.get(req)).code, 404);
  });

  it('follows upstream redirects', async function () {
    const req = testUtils.mockRequest('mocks', '/redirect');
    const res = httpMocks.createResponse();
    nock(req.conf.host).get('/redirect').reply(302, '', { location: '/target' })
      .get('/target').reply(200, 'redirected');
    await proxy()(req, res, () => assert.fail());
    assert.equal(res._getData(), 'redirected');
  });

  for (const acceptEncoding of [undefined, 'gzip', 'gzip, deflate, br']) {
    it(`decodes gzip once when recording and replaying with accept-encoding ${acceptEncoding}`, async function () {
      const req = testUtils.mockRequest('mocks', '/gzip', {
        headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {}
      });
      nock(req.conf.host).get('/gzip').reply(200, gzipSync('compressed response'), {
        'content-encoding': 'gzip', 'content-type': 'text/plain'
      });
      const res = httpMocks.createResponse({ eventEmitter: require('node:events').EventEmitter });
      const ended = new Promise(resolve => res.on('end', resolve));
      await proxy()(req, res, () => assert.fail());
      await ended;
      assert.equal((await cacher.get(req)).body, 'compressed response');
      assert.equal(gunzipSync(res._getBuffer()).toString(), 'compressed response');

      const replay = httpMocks.createResponse({ eventEmitter: require('node:events').EventEmitter });
      const replayEnded = new Promise(resolve => replay.on('end', resolve));
      await cache()(req, replay, () => assert.fail());
      await replayEnded;
      assert.equal(replay.getHeader('content-encoding'), 'gzip');
      assert.equal(gunzipSync(replay._getBuffer()).toString(), 'compressed response');
    });
  }

  it('does not proxy mappings with noproxy set', async function () {
    const req = testUtils.mockRequest('mocks', '/disabled', { conf: { noproxy: true } });
    const res = httpMocks.createResponse();
    await proxy()(req, res, () => assert.fail());
    assert.equal(res.statusCode, 204);
    assert.equal(await cacher.get(req), false);
  });

  it('passes ignored requests to the next middleware', async function () {
    for (const url of ['', '/', '/__health']) {
      let called = false;
      await proxy()({ url }, {}, () => { called = true; });
      assert.equal(called, true);
    }
  });

  it('reports network errors without an unhandled rejection or cache entry', async function () {
    const req = testUtils.mockRequest('mocks', '/network-error');
    const res = httpMocks.createResponse();
    nock(req.conf.host).get('/network-error').replyWithError('connection reset');
    await proxy()(req, res, () => assert.fail());
    assert.equal(res.statusCode, 500);
    assert.equal(await cacher.get(req), false);
  });

  it('forwards raw JSON request bodies and headers', async function () {
    const req = testUtils.mockRequest('mocks', '/json', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'test-token' }
    });
    req.body = Buffer.from('{"hello":"world"}');
    req.headers['content-length'] = req.body.length;
    const res = httpMocks.createResponse();
    nock(req.conf.host, { reqheaders: { authorization: 'test-token', 'content-type': 'application/json' } })
      .post('/json', { hello: 'world' }).reply(201, 'created');
    await proxy()(req, res, () => assert.fail());
    assert.equal(res.statusCode, 201);
    assert.equal(res._getData(), 'created');
  });
});
