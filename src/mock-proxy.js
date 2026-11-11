import axios from 'axios';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { hasBody } from 'type-is';
import config from 'config';
import cacher from './cacher';
import { passthru, errorHandler, shouldIgnore } from './app-utils';

const proxyConfig = config.has('proxy') ? config.get('proxy') : {};
const timeout = proxyConfig.timeout || 5000;
const disabled = !!proxyConfig.disable;

const middleware = () => async (req, res, next) => {
  if (shouldIgnore(req)) {
    return next();
  }
  if (disabled || req.conf.noproxy) {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = req.conf.host + req.urlToProxy;
  const headers = { 'accept-encoding': 'identity', ...req.headers };
  // Remove encoding because we've processed the body already.
  delete headers['content-encoding'];
  // Reset host
  delete headers.host;
  try {
    const response = await axios({
      url,
      method: req.method,
      timeout,
      headers,
      data: hasBody(req) ? req.body : undefined,
      responseType: 'arraybuffer',
      decompress: false,
      validateStatus: () => true
    });
    let body = response.data;
    if (response.headers['content-encoding'] === 'gzip') {
      body = await promisify(gunzip)(body);
    }
    const data = {
      code: response.status,
      headers: response.headers.toJSON(),
      body: body.toString('utf8')
    };
    await cacher.set(req, data);
    passthru(res, data);
  } catch (err) {
    errorHandler(res, err);
  }
};

export default middleware;
