const httpMocks = require('node-mocks-http');
const qs = require('qs');
const props = require('../lib/props').default;

module.exports = function () {
  return {
    mockRequest: function (apiKey, url, options = {}) {
      if (!apiKey) throw new Error('apiKey must be defined');
      const headers = { ...options.headers };
      if (options.body && !headers['content-type']) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      if (options.body) headers['content-length'] = Buffer.byteLength(qs.stringify(options.body));
      const req = httpMocks.createRequest({
        method: options.method || 'GET',
        url: '/' + apiKey + url,
        query: qs.parse(url.split('?')[1]),
        headers,
        body: options.body ? Buffer.from(qs.stringify(options.body)) : undefined
      });
      req.conf = {
        key: apiKey,
        dir: apiKey,
        host: 'http://127.0.0.1:4969',
        matchHeaders: Object.keys(options.headers || {}),
        ...options.conf
      };
      req.urlToProxy = url;
      props()(req, {}, () => {});
      return req;
    }
  };
};
