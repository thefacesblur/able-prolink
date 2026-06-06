// Stub: prolink-connect calls Database(':memory:') without `new` (the (0, fn)() pattern)
// to create an in-memory SQLite DB for metadata hydration. This path needs the native
// better-sqlite3 addon, which can't run inside the Extension Host sandbox.
//
// Using a plain function (not a class) so the (0, fn)() call pattern works and our throw
// reaches fetchMetadata's try-catch — a class stub fails with a native "Class constructor
// cannot be invoked without 'new'" before the throw ever runs.
function Database() {
  throw new Error("better-sqlite3 is not available — track metadata will be missing");
}
export default Database;
