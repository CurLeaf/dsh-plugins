# Notice

`dsh-patch/pre/` and `dsh-patch/patched/` contain **modified copies** of build
artifacts from the following packages, all published by DeepSeek under the MIT
license:

| Package | Version | Files |
|---|---|---|
| `@deepseek-ai/dsh-commands` | 0.2.1-rc.3 | `lib/index.js`, `lib/typert.host.js`, `lib/typert.remote-client.js`, `lib/types/index.d.ts`, `lib/types/types.d.ts` |
| `@deepseek-ai/dsh-client-ui-commands` | 0.2.1-rc.3 | `lib/client.js` |
| `@deepseek-ai/dsh-client-ui-input-trigger` | 0.2.1-rc.3 | `lib/client.js` |

They are redistributed here so the patcher can verify a target against its
pristine image (`pre/`) and write the patched image (`patched/`) without network
access. `dsh-patch/diffs/` holds the same changes as unified diffs.

Each upstream package ships under the MIT license (`LICENSE` inside the package,
and `@deepseek-ai/dsh`'s own `LICENSE`). Their copyright notice and permission
terms are retained by that license; this repository claims no authorship over
the unmodified portions of those files.

Upstream: <https://github.com/deepseek-ai/deepseek-harness>
