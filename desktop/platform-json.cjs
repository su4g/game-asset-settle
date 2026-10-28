"use strict";
// Preserve platform identifiers beyond Number.MAX_SAFE_INTEGER before JSON.parse rounds them.
// The tokenizer consumes entire quoted strings (including escapes), so numbers in names stay untouched.
function parsePlatformJson(source) {
  const protectedIntegers = source.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) return JSON.stringify(token);
    return token;
  });
  return JSON.parse(protectedIntegers);
}
module.exports = { parsePlatformJson };
