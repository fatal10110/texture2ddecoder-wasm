// Not part of the build: typechecked by tests/browser-safety.test.ts, which
// asserts that the package tsconfig rejects DOM globals (R4).
document.createElement("canvas");
