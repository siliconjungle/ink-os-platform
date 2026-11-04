# Typed effects example

`save_nonce(name,expected)` samples 16 random bytes, then writes them to an
app-private virtual file using a version check. The sequence and continuation
are Ink; no JavaScript app backend is required. The returned `EffectReply<Unit>`
contains the file version or a typed error. Read the current version before an
update; use 0 for a new file.

Build/deploy this directory with the normal Ink OS CLI. After publishing:

```sh
ink-os ink run APP_ID save_nonce --input '["nonce",0]'
```

See [typed effects](../../docs/typed-effects.md) for resource policies, retries,
cancellation, recovery, and the SDK. This example needs no HTTP/process policy.
