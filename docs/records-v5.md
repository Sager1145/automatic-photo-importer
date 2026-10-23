# Records v5: one "Photo Importer Data" folder per drive

Since version 0.3.0 every record the app writes on a drive lives in one visible folder,
`Photo Importer Data`, at the configured destination a library lies beneath (same volume), or in the
library itself when it is not beneath a destination. Nothing of the app's is written beside media any more.

```
<destination>/Photo Importer Data/
  store.json                         sealed: base folder identity, minVersion 0.3.0
  Organizations/<id>/journal.jsonl   header line, entries line, then one sealed event per line
  Organizations/<id>/originals/<i>/<slot>/<name>   originals kept for undo
  Organizations/deleting-<id>-<uuid>/ a deletion set aside (removed by the cleanup)
  Pointers/<folder> <hash8>/journal-<id>.json      sibling pointers, per folder they protect
  Imports/receipts-000001.jsonl      import receipts: sealed open/close lines, a new segment every 8 MiB
  Imports/Staging/<uuid>.partial     staged copies, linked or copied into place
  Libraries/<library> <hash8>/index.json, duplicates.json   sealed caches
```

Every record is sealed with this Mac's host key over `photo-importer:v5:<kind>\n<JSON>`, so a record of one kind,
or one an earlier version sealed, never verifies as another. Logs are read in 1 MiB chunks, line by line, and
appended in groups: one write, one sync of the file, one sync of its folder.

## Converting what earlier versions wrote

When nothing else uses a connected destination, the app converts its earlier records automatically
(`core/migrate/`): each organization journal (with its kept originals, moved one by one and each recorded),
sibling pointers, import receipts and staged copies, the index and duplicate store, drive markers, and finally the
old `Photo Importer Recovery` folders. Every step finishes from what is on disk, so a stop, a crash or an unplugged
drive is picked up on the next run. Until a library's journals are converted, organizing, resuming, undoing,
finalizing, deleting records and Remove duplicates there are refused; imports go on. Anything that cannot be
converted (another Mac's records, something unexpected in an old folder) is left exactly as it was and listed in
Settings › Organization.

The cleanup deletes ended organizations (fully undone, replaced, or with their kept originals released) that hold
no kept original and that no other journal still names. It never removes kept originals, a staged copy that may be
the only copy, or anything outside the records folder unless you choose Clean up.

## Downgrading

Versions before 0.3.0 do not read this folder. Going back to one on a drive that has it is not supported.
