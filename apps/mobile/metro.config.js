// Metro does not read tsconfig `paths`, so @clearwater/shared is wired explicitly.
// (Alternative once a root workspace exists: npm workspaces + symlink.)
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, '../../packages/shared');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [...(config.watchFolders ?? []), sharedRoot];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@clearwater/shared': path.join(sharedRoot, 'src'),
};
module.exports = config;
