module.exports = [
  { ignores: ['lib/**', 'public/**'] },
  ...require('neostandard')({ semi: true, env: ['mocha'] })
];
