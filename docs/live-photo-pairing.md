# Live Photo pairing (release note)

A `.mov` with the same name as a HEIC, HEIF, JPG or JPEG in the same folder is now filed with that still when their `ContentIdentifier` values match. If either file has none, the pair is made only when the still's camera Make is Apple. A HEIC is preferred over a JPG. The MOV's own companions (`.MOV.xmp`, `.LRV`) follow it.

The MOV goes to the still's folder, with the still's camera, date and format folder, and is not a separate video family.

## Behaviour change

- With a video-root layout (photos and videos in separate roots), a Live Photo MOV used to be filed as a video. It now goes to the photo root beside its still.
- Re-importing a card that was imported before this change copies those MOVs again, to their new path, because the old copies sit in the video location.
- A MOV whose still is empty is left in place with its companions. A MOV with no still, or with a different `ContentIdentifier`, is unchanged.

The scan-memory file version is 4, so scans remembered before this change are read again once.
