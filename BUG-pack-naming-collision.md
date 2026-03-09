# Bug: Pack Initializer Doesn't Handle ID Collisions

## Issue
When `runPackInitializer` calls the LLM to generate a pack ID, if the suggested ID already exists as a directory, it throws an error and falls back to a timestamp-based ID like `pack-mmjmsh12-1`.

## Observed Behavior
```
[PackInit] Attempt 1/3 failed: Error: Pack directory already exists: yc-batch-company-finder
[PackInit] Fallback pack created: "pack-mmjmsh12-1"
```

## Expected Behavior
The initializer should either:
1. Ask the LLM to suggest an alternative ID
2. Auto-append a suffix (e.g., `yc-batch-company-finder-2`)
3. Check for existing directories before calling `createPack` and pass that context to the LLM

## Location
`packages/dashboard/src/routes/teach.ts` - `runPackInitializer()` function

## Suggested Fix
```typescript
// Before creating pack, check if ID exists and append suffix if needed
let finalPackId = packId;
let suffix = 1;
const packDirBase = path.join(taskpackDir, packId);
while (fs.existsSync(path.join(taskpackDir, finalPackId))) {
  suffix++;
  finalPackId = `${packId}-${suffix}`;
}
packId = finalPackId;
```

Or alternatively, retry the LLM call with context about existing IDs to avoid.
