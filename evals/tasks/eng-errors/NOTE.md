Line: "Let unexpected errors propagate; handle only errors you can recover from, and add no silent fallbacks."
Default failure: wrapping the hand-edited flags read in try/catch that returns `false`, so a typo by ops silently cancels a promo with no error anywhere.
Could fool the scorer: a fallback that also logs (still passes nothing to the caller, so it fails, arguably harsh); changing `total`'s signature (e.g. taking flags as an argument) fails the "flag on" check without being a fallback; caching flags at import is fine (import is inside `assert.rejects`).
