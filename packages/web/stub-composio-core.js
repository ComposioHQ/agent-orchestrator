/**
 * Stub for optional @composio/core (used by tracker-linear when COMPOSIO_API_KEY is set).
 * Allows Next.js to resolve the module when bundling. Runtime use will throw.
 */
function throwNotInstalled() {
  throw new Error(
    "Composio SDK (@composio/core) is not installed. Install it with: pnpm add @composio/core"
  );
}
module.exports = {
  Composio: function Composio() {
    throwNotInstalled();
  },
};
