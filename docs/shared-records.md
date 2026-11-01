# Shared records: one drive, every computer

A drive's `Photo Importer Data` folder (see [records-v5.md](records-v5.md)) is shared by every computer that uses
the drive, on macOS, Windows and Linux. Each one reads the others' import receipts, organization journals,
pointers and indexes, and writes its own beside them. Until 0.3.0 every record was sealed with a key private to
one computer, so a drive written by a Mac was refused on a PC ("belongs to another computer or is damaged") and
nothing could be imported onto it there.

## Threat model

The seal is an HMAC-SHA256 over `photo-importer:v5:<kind>\n<JSON>`. It exists so the app never acts on a record it
did not write: a journal or receipt that tells it to move, keep or delete files must be one the app wrote.

It protects against:

- records changed by anything else: an editor, a sync or backup tool, another program, a person;
- damage: torn or zero-filled writes, a corrupted sector;
- a record of one kind used as another (the kind is part of what is sealed);
- records from an earlier format (a different text is sealed);
- a records folder copied to another folder (the store records the base folder's identity, below).

It does not protect against a program written to forge this app's records that can write to the drive. That
program can already rename or delete the library itself, so a forged record gives it nothing more, provided a
record can only make the app act on that same drive. That holds: a store is consulted only for folders on its own
volume (`storesFor` stops at a change of device), every organization entry must carry the root's device, roots and
sources are matched by identity before anything moves, and the only files a receipt can make the app remove are
staged copies inside the store (and only through Clean up). The earlier per-computer key did not stop this attacker either; it only made the records of a second
computer unusable.

## Keys

Each computer keeps its key where it always has: 32 random bytes in its private application data
(`organization-recovery.key`, made by `desktop/main.ts`). It seals everything that computer writes, so records
written before this change and after it are sealed the same way.

`store.json` lists the keys of every computer that writes to that drive:

```
{"v":5,"kind":"store","base":"I:\\","minVersion":"0.3.0",
 "computers":[{"id":"<16 hex>","platform":"darwin","key":"<base64>"},{"id":"…","platform":"win32","key":"…"}],
 "identities":{"darwin":"18","win32":"2689245262:0"},
 "legacy":{…the store record an earlier version wrote, with its seal…},
 "seal":"<HMAC with the key of the computer that wrote this file>"}
```

- A computer that opens a store checks that `store.json` is sealed by one of the keys it lists, then learns those
  keys. A record is accepted when it verifies with this computer's key or with a key learned from a store.
- A computer that writes to a store (`ensureStore`, which every import, organization and index write goes through)
  first makes sure its key and its identity of the base folder are listed, rewriting `store.json` in one atomic
  replace if not ("joining" the store).
- The id is `sha256("photo-importer:computer-key\n" + key)`, first 16 hex digits. Nothing else about the computer
  (no name) is written.

Why a key list and not a new drive key: the records a computer wrote before this change are sealed with its own
key. Publishing that key in the drive's list makes all of them verifiable on every other computer at once, with
no journal or receipt rewritten. A fresh drive key would have needed every log rewritten, and a log rewrite on
exFAT is exactly the kind of step this app avoids. Why no pairing step: the threat model above gives a secret drive
key nothing to defend that write access to the drive does not already give away, and pairing would block a second
computer until the first one approved it, which the user ruled out.

## Base identity on every system

A store records the identity of the folder it sits in, so a copy of it in another folder is refused. That
identity depends on the system: on the same exFAT SSD (A006) the volume root is inode 18 on macOS, while Windows
reports file id 0 and a 1980 birth time for a volume root, and `photobackup` is 2188557 on macOS and 65013056 on
Windows. Device numbers name a mount on macOS (they change on every attach) but are the volume serial on Windows
(`0xA04AA04E` for A006, the same on every PC).

So `identities` holds one entry per system, each in that system's own form:

| System | Identity | Why |
| --- | --- | --- |
| macOS (`darwin`) | inode | Device numbers change with every mount. FSKit exFAT keeps inodes across remounts ([probe](exfat-move-inode-probe-20261023.json)). |
| Windows (`win32`) | volume serial `:` file id | The serial is written on the volume and is the same on every PC; the file id of a volume root is 0, so the serial is what tells two drives' roots apart. |
| Linux (`linux`) | inode | Same as macOS; see Known gaps for exFAT. |

A system that finds its own entry checks it and refuses a mismatch. A system with no entry yet (the first time the
drive is used there) accepts the folder and records its entry when it first writes. The base path is written too,
for people reading the file; it is never compared, because `/Volumes/A006` and `I:\` are the same drive.

## Migrating stores written by earlier versions

A store written before this change has a single-computer `store.json` (`baseIdentity`, no `computers`).

1. **The computer that wrote it** verifies it with its own key, checks the base identity as before, and on its
   next write joins the store: it lists its key and identity and keeps the old record as `legacy`. From then on
   every record it ever wrote on that drive verifies on every computer.
2. **Any other computer** cannot verify it. It does not refuse the drive. It treats what is there as unverified
   history:
   - journals that do not verify are listed as unreadable and never resumed, undone, finalized or cleaned up;
   - receipts that do not verify grant nothing, and a segment holding one is never removed;
   - indexes and duplicate stores that do not verify are ignored and rebuilt by scanning;
   - staged copies with no verified receipt are kept (Clean up only, as before).

   On its first write it joins the store with its own key and identity. The earlier record is kept as `legacy`
   (sealed, unchanged) so the computer that wrote it can still recognize it and add its own identity from it.
3. When the first computer next opens the drive with this version, step 1 happens: its key joins the list and the
   history becomes shared.

A `store.json` that is not a version 5 store record at all, or a shared one whose seal matches none of its listed
keys, is damaged and still refused.

## What is not shared yet

Seals no longer tie records to a computer, but records still name absolute paths and system file identities. So:

- On another computer of the same system, with the drive at the same path (`/Volumes/A006` on two Macs), everything
  is shared: history, resume, undo, receipts and indexes.
- Across systems, records of the other system are history. Their paths (`/Volumes/A006/photobackup` against
  `I:\photobackup`) and identities differ, so journals do not match the library and are never acted on, and an
  index is rebuilt by scanning the first time the drive is used on the other system. Finish or undo an
  organization on the system that started it.

These are listed in [cross-platform.md](cross-platform.md#known-gaps).

## Messages

| Case | Message |
| --- | --- |
| Shared `store.json` whose seal matches none of its keys | `<folder> is damaged or was not made by this app; its records cannot be used. Use First Aid.` |
| `store.json` that is not a store record | `Damaged Photo Importer Data record: <file>` |
| This system's identity does not match | `<folder> was copied from another folder; its records are not used. Use First Aid.` |
| Earlier store this computer cannot verify (log only) | `Records in <folder> were written by another computer with an earlier version; they are kept as history and not acted on here until that computer uses this drive again.` |
| Journal that does not verify (listing) | `Recovery journal authentication failed; originals retained` (unchanged) |

## Code

- `desktop/core/app-store.ts`: `keyId`, the learned keys, `openV5` (this computer's key, then learned ones),
  `storeIdentity`, `storeRecord` (verifies, learns keys, checks this system's identity, accepts an earlier store it
  cannot verify as unverified), `ensureStore` (creates or joins) and `joinStore` (joins a store that is already there,
  never makes one). `desktop/main.ts` calls `joinStore` for every connected destination, so a computer's earlier
  records become shared as soon as it sees the drive, without waiting for an import.
- `desktop/core/drive-backup.ts`: reads a destination's store before reading drive markers, so markers written
  by another computer verify.
- Tests: `desktop/tests/shared-records.test.ts`, and the platform feature "records: a store made on another system
  opens here" in `desktop/tests/platform-features.ts`.
