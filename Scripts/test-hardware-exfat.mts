/**
 * Thin wrapper kept for existing docs: runs the 01-cycle group of the hardware exFAT test (see Scripts/hw/run.mts).
 *
 *   node --import tsx Scripts/test-hardware-exfat.mts --source=/Volumes/A006 --library=/Volumes/Untitled [--keep] [--files=N] [--host-key=<path>]
 */
process.argv=[...process.argv.filter(arg=>!arg.startsWith('--only=')),'--only=01-cycle'];
await import('./hw/run.mts');
