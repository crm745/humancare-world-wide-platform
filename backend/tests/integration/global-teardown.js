// Releases the session lock taken by global-setup.js. It deletes nothing else: no rows, no files, no tables.
module.exports = async function integrationGlobalTeardown() {
  if (typeof global.__INTEGRATION_RELEASE_LOCK__ === 'function') global.__INTEGRATION_RELEASE_LOCK__();
};
