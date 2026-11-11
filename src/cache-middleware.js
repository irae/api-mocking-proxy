import cacher from './cacher';
import { passthru, shouldIgnore } from './app-utils';

const middleware = () => async (req, res, next) => {
  if (shouldIgnore(req)) {
    return next();
  }
  try {
    const payload = await cacher.get(req);
    if (!payload) {
      // Not in cache, keep on moving.
      return next();
    }
    passthru(res, payload);
  } catch (err) {
    console.log('Cache error', err);
    next();
  }
};

export default middleware;
