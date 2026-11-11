const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const testUtils = require('./test-utils')();
const cacher = require('../lib/cacher').default;
const { resolveMockPath } = require('../lib/app-utils');
const { parse, stringify } = require('../lib/cache-persist');

describe('response-cacher', function () {
  let root;
  before(async function () {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'amp-cache-'));
    cacher.root = root;
    await fs.mkdir(path.join(root, 'mocks/GET'), { recursive: true });
  });
  after(async function () {
    await fs.rm(root, { recursive: true, force: true });
  });

  const cases = [
    ['/hello', 'hello'],
    ['/greeting/hello', 'greeting__hello'],
    ['/hello?a=b', 'hello/a=b'],
    ['/hello?a=b&c=d', 'hello/a=b&c=d'],
    ['/hello/a/b/c/d', 'hello__a__b__c__d'],
    ['?a=b&c=d', 'index/a=b&c=d'],
    ['/hello', 'Authorization__12345/hello', { headers: { Authorization: 12345 } }],
    ['/hello', 'Authorization__12345/Access-Control-Allow-Origin__http~~____www.example.com/hello', {
      headers: { Authorization: 12345, 'Access-Control-Allow-Origin': 'http://www.example.com' }
    }],
    ['/hello?a=b', 'Authorization__12345/hello/a=b', { headers: { Authorization: 12345 } }],
    ['/hello/a/b/c/d', 'Authorization__12345/hello__a__b__c__d', { headers: { Authorization: 12345 } }],
    ['/hello', 'hello/a=b&c=d', { method: 'POST', body: { a: 'b', c: 'd' } }],
    ['', 'index/a=b&c=d', { method: 'POST', body: { a: 'b', c: 'd' } }],
    ['/hello', 'Authorization__12345/hello/a=b&c=d', {
      method: 'POST', body: { a: 'b', c: 'd' }, headers: { Authorization: 12345 }
    }],
    ['/hello', 'Authorization__12345/Access-Control-Allow-Origin__http~~____www.example.com/hello/a=b&c=d', {
      method: 'POST',
      body: { a: 'b', c: 'd' },
      headers: { Authorization: 12345, 'Access-Control-Allow-Origin': 'http://www.example.com' }
    }],
    ['/hello', 'hello/a=b&c=d', { method: 'PUT', body: { a: 'b', c: 'd' } }],
    ['/hello', 'hello/a=b&c=d', { method: 'DELETE', body: { a: 'b', c: 'd' } }]
  ];

  for (const [url, filename, options = {}] of cases) {
    describe((options.method || 'GET') + ' ' + (url || '(root)') + ' ' + filename, function () {
      const req = testUtils.mockRequest('mocks', url, options);
      it('keeps the current cache filename', function () {
        assert.equal(resolveMockPath(req, root), path.join(root, 'mocks', req.method, filename + '.mock'));
      });
      it('reads a saved response', async function () {
        const data = { code: 201, headers: { 'content-type': 'application/json' }, body: '{"msg":"hello world"}' };
        const file = resolveMockPath(req, root);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, stringify(data));
        assert.deepEqual(await cacher.get(req), data);
      });
      it('saves a response using the same plain text format', async function () {
        const data = { code: 200, headers: { 'content-type': 'application/json' }, body: { msg: 'hello world' } };
        await cacher.set(req, data);
        assert.equal(await fs.readFile(resolveMockPath(req, root), 'utf8'),
          '200\n\ncontent-type: application/json\n\n{"msg":"hello world"}');
        assert.deepEqual(await cacher.get(req), data);
      });
    });
  }

  it('reads and round-trips all existing plain text fixtures', async function () {
    async function check (dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await check(file);
        } else {
          const content = await fs.readFile(file, 'utf8');
          assert.equal(stringify(parse(content)), content);
        }
      }
    }
    await check(path.join(__dirname, 'mocks'));
  });

  it('reads a legacy JSON response from the cache', async function () {
    const req = testUtils.mockRequest('mocks', '/legacy');
    const fixture = JSON.stringify({ code: 202, headers: { 'content-type': 'application/json' }, body: '{"legacy":true}' });
    await fs.writeFile(resolveMockPath(req, root), fixture);
    assert.deepEqual(await cacher.get(req), JSON.parse(fixture));
  });

  it('ignores request headers unless configured to match them', async function () {
    const req = testUtils.mockRequest('mocks', '/hello', {
      headers: { authorization: '12345' }, conf: { matchHeaders: false }
    });
    assert.equal(resolveMockPath(req, root), path.join(root, 'mocks/GET/hello.mock'));
  });

  it('keeps hashes for long query strings', function () {
    const req = testUtils.mockRequest('mocks', '/hello?a=' + 'x'.repeat(150));
    const props = 'a=' + 'x'.repeat(150);
    const hash = createHash('sha1').update(props).digest('hex');
    assert.equal(resolveMockPath(req, root), path.join(root, 'mocks/GET/hello', hash + '-' + props.slice(0, 120) + '.mock'));
  });

  it('preserves encoded and repeated slashes in cache paths', function () {
    const req = testUtils.mockRequest('mocks', '/a%2Fb//c?x=1');
    assert.equal(resolveMockPath(req, root), path.join(root, 'mocks/GET/a%2Fb____c/x=1.mock'));
  });

  it('keeps matching and ignored query properties', function () {
    const req = testUtils.mockRequest('mocks', '/hello?a=b&c=d&nonce=123', {
      conf: { matchProps: ['a', 'nonce'], ignoreProps: ['nonce'] }
    });
    assert.equal(resolveMockPath(req, root), path.join(root, 'mocks/GET/hello/a=b.mock'));
    req.conf.matchProps = false;
    assert.equal(resolveMockPath(req, root), path.join(root, 'mocks/GET/hello.mock'));
  });

  it('returns false for missing and empty files', async function () {
    const req = testUtils.mockRequest('mocks', '/empty');
    assert.equal(await cacher.get(req), false);
    await fs.writeFile(resolveMockPath(req, root), '');
    assert.equal(await cacher.get(req), false);
  });

  it('touches an empty file without changing its contents', async function () {
    const req = testUtils.mockRequest('mocks', '/touched', { conf: { touchFiles: true } });
    assert.equal(await cacher.get(req), false);
    const file = resolveMockPath(req, root);
    assert.equal(await fs.readFile(file, 'utf8'), '');
    await fs.utimes(file, new Date(0), new Date(0));
    assert.equal(await cacher.get(req), false);
    assert.ok((await fs.stat(file)).mtimeMs > 0);
  });

  it('does not truncate existing files when caching is disabled', async function () {
    const req = testUtils.mockRequest('mocks', '/touched', { conf: { touchFiles: true, nocache: true } });
    const file = resolveMockPath(req, root);
    await fs.writeFile(file, 'existing contents');
    assert.equal(await cacher.get(req), false);
    assert.equal(await fs.readFile(file, 'utf8'), 'existing contents');
  });

  it('rejects absent response data', async function () {
    await assert.rejects(cacher.set(testUtils.mockRequest('mocks', '/hello')), /data must be provided/);
  });
});
