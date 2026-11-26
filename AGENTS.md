# Project workflow

- Canonical checkout: D:\p\github\zhihu-long-image. Make future changes here.
- Keep this as a single project directory without version suffixes. Do not create a new directory or archive for every change.
- Keep source, required runtime dependencies/assets, tests and documentation. Do not keep release ZIPs or dist/ in this checkout after ordinary development.
- The userscript is the canonical export-engine source. Run `node scripts/build.cjs` after modifying it to update the extension.
- Validate completed changes with `npm test` and relevant existing browser checks when behavior changes.
- After each completed, verified change, create a local Git commit with a concrete summary. Do not commit unrelated changes or credentials.
- Do not push or publish unless the user explicitly requests it. Generate release packages only when publishing is requested.
- Preserve the user's source files and any uncommitted changes.
