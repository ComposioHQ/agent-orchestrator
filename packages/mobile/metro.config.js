const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Disable package exports resolution — some packages (math-intrinsics, expo-application)
// have invalid or incomplete `exports` fields that cause Metro bundling failures.
// Falling back to classic file-based resolution fixes these.
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
