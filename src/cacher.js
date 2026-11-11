import { resolveMockPath } from './app-utils';
import * as file from './files';
import config from 'config';
import { resolve } from 'path';
import { open, utimes } from 'node:fs/promises';
import { parse, stringify } from './cache-persist';

const cacheConfig = config.has('cache') ? config.get('cache') : {};
const dataRoot = resolve(cacheConfig.dataRoot || 'data');
const disabled = !!cacheConfig.disable;
const touchFiles = !!cacheConfig.touchFiles;

const tap = (fn, ...params) => input => {
  return fn(input, ...params).then(() => input);
};

const doTouch = async (content, file, conf) => {
  if (!content && (touchFiles || conf.touchFiles)) {
    const handle = await open(file, 'a');
    await handle.close();
    const now = new Date();
    await utimes(file, now, now);
  }
  return false;
};

class Cacher {
  constructor () {
    this.root = dataRoot;
  }

  get (req) {
    const mockFile = resolveMockPath(req, this.root);
    if (disabled || req.conf.nocache) {
      return doTouch(false, mockFile, req.conf);
    }
    return file
      .read(mockFile)
      .then(parse)
      .then(tap(doTouch, mockFile, req.conf));
  }

  set (req, data) {
    if (!data) {
      return Promise.reject(new Error('Invalid argument: data must be provided!'));
    }
    const mockPath = resolveMockPath(req, this.root);
    return file.write(mockPath, stringify(data));
  }
}

export default new Cacher();
