# Other files: what leaves the library, and how it is recognized

A library holds camera photos and videos, and the edited exports made from them. Everything else goes to the library's
**other-files folder**: a folder beside the library, on the same drive, named after it with `-otherfiles`.

| Library | Other-files folder |
| --- | --- |
| `I:\photobackup` (Windows) | `I:\photobackup-otherfiles` |
| `/Volumes/A006/photobackup` (macOS) | `/Volumes/A006/photobackup-otherfiles` |
| `/media/<user>/A006/photobackup` (Linux) | `/media/<user>/A006/photobackup-otherfiles` |
| A drive's own top folder (`I:\`, `/Volumes/A006`) | Inside it: `I:\library-otherfiles`, `/Volumes/A006/A006-otherfiles` (nothing beside it is on that drive) |

Code: `desktop/core/other-files.ts` (place, name rules, dates), `desktop/core/folder-rules.ts` (`evaluateRoutes`: which
category), `desktop/core/index.ts` (`plan`: the `other` part of each destination's plan). The rules are the same on macOS,
Windows and Linux; paths written use each system's separator and every stored relative path uses `/`.

## Categories

| Folder | What goes there |
| --- | --- |
| `Screenshots` | Screenshots and screen recordings |
| `Chat images` | Pictures and videos saved from messaging apps (WeChat, WhatsApp, LINE, Telegram, Messenger, QQ) |
| `Broken files/Empty files`, `Broken files/Unreadable files` | 0-byte files with their families (what `Problem files` held), and media whose metadata cannot be read |
| `Unknown files` (or the name chosen in Settings › Importing › Files without metadata) | Media with no capture date, no camera and no known origin |
| `Other files` | Everything that is not a photo or video: archives, documents, camera index files (`NC_FLLST.DAT`, `.CTG`), Finder aliases, `uuid=…` files, Mac files kept on purpose |

Inside each category the files keep **date folders** made by the library's folder template, without the camera level
(`{year}/{yyyymm}/{camera}` gives `Screenshots/2026/202601/…`). A date is known from, in order:

1. the family's capture date (metadata);
2. a date in the file name (`Screenshot_20260115-…`, `IMG-20250102-WA0001`, `mmexport<milliseconds>`);
3. the dated folders the file already sits in, read by the same template (`2022/202203/Unknown files/x.png` → `Unknown files/2022/202203/x.png`);
4. for `Other files` only, the file's modified time: a file that is not media has no other date.

With none of these the file goes directly in its category folder. The folders a file came from are never rebuilt there
(no `Drive backups/…`, no `Unknown files/…/Unknown files`). A name already taken by other content goes to
`Conflicts/<content id>/` beside it, as in the library. Broken files filed flat under one name get a short digest of where
each came from (`EMPTY (3f2a1c).JPG`), so none hides another.

## What stays in the library

* **Every file with a camera** in its metadata, whatever its name or format: a camera photo is never filed as a screenshot,
  even one named `Screenshot_…png`.
* **Edited exports**, recognized from metadata (`Software`, `ProcessingSoftware`, `CreatorTool`, `ImageEditingSoftware`,
  `RAWDevelopingSoftware`, XMP `History` software agents) or by already sitting in the edited folder. They go to the edited
  folder (`{year}/{yyyymm}/<edited folder>/<camera>`), and without a camera to `{year}/{yyyymm}/<edited folder>/` itself.
  Editors recognized: Photoshop, Lightroom, Capture One, darktable, RawTherapee, Affinity Photo, DxO, GIMP, Snapseed, VSCO,
  PicsArt, Polarr, Pixelmator, Luminar, ON1 Photo, NX Studio, Capture NX, ViewNX, Digital Photo Professional, Imaging Edge,
  SILKYPIX, FUJIFILM X RAW STUDIO, OM/Olympus Workspace, Darkroom, Afterlight, Facetune, Meitu, 醒图/Hypic, and macOS Photos
  (`Photos <version>`). Camera firmware (`NIKON Z f Ver.01.10`, `ILCE-7M4 v2.00`) and phone system versions (`17.1`) are not
  editors. RAW files are never edited exports.
* Companions (sidecars, proxies, Live Photo videos) always follow their original, in or out.
* A file type the user gave a folder rule (Settings › Importing › Unknown file types) keeps that folder.

## Recognizing screenshots and chat images

Checked only for media with no camera. Metadata first, then the name.

| Rule | Source | Confidence |
| --- | --- | --- |
| `UserComment` (or description) is `Screenshot` | Apple (iOS, macOS) | High |
| `Software`/`CreatorTool` is a screenshot tool: Snipping Tool, Snip & Sketch, ShareX, Greenshot, Snagit, Lightshot, Flameshot, Spectacle, gnome-screenshot, Xbox Game Bar, Snipaste, CleanShot, Monosnap | Windows, Linux, macOS tools | High |
| `Author` is `ReplayKitRecording` | iOS screen recording | High |
| `Copyright` starts with `wxmm`, or a comment holds `"WXVer"` | WeChat | High |
| Name starts with `Screenshot`, `Screen Shot`, `Capture d’écran`, `Bildschirmfoto`, `Schermafbeelding`, `Captura de pantalla`, `Snipaste_`, `スクリーンショット`, `截屏`, `截圖`, `截图`, `屏幕截图`, `屏幕快照`, `螢幕截圖`, `螢幕快照`, `微信截图`, `QQ截图`, `스크린샷` | Android, Windows, macOS in several languages | High |
| Name starts with `RPReplay_`, `ScreenRecording_`, `Screen Recording`, `录屏`, `屏幕录制`, `画面収録` | Screen recordings | High |
| `mmexport…`, `wx_camera_<digits>`, `microMsg.<digits>`, `_WC-EditVideo_` | WeChat | High |
| `IMG-YYYYMMDD-WA…`, `VID-YYYYMMDD-WA…`, `WhatsApp Image YYYY-MM-DD …` | WhatsApp | High |
| `photo_YYYY-MM-DD_hh-mm-ss`, `telegram-cloud-photo-…` | Telegram | High |
| `QQ图片<digits>` | QQ | High |
| `LINE_P<date>`, `LINE_ALBUM_…`, `LINE_MOVIE_…` | LINE | Medium |
| `received_<digits>` | Messenger | Medium |
| `IMG_1234.PNG` with no camera | iOS saves screenshots under this name | Medium |
| A PNG or HEIC with no camera at exactly a phone, tablet or computer screen size (either orientation) | Any screenshot | Medium |

A medium rule can catch a picture that is not a screenshot (an exported PNG at 1920×1080); it never catches a camera
photo, which always has a camera. What no rule identifies is unknown, or, when it is not media, other.

## When it happens

* **Imports** file new files straight into the other-files folder, made when the first file goes there. A file already in
  the library under an earlier version's folders is found by content and not copied again.
* **Library organization** moves what earlier versions kept in the library: `Unknown files` (at the top or inside a month),
  `Problem files`, `Drive backups`, in-library `Screenshots`/`WeChat` camera folders, and any non-media file. The moves are a
  journal of their own, kept with the other-files folder: listed in Settings › Recovery and undoable like every
  organization. The library check (Check folder layout) counts such files as misplaced until they are moved.
* Choosing **Keep** for files without metadata leaves unknown and unreadable media where they are; **Use file date** files
  them in the library by file time. Screenshots, chat images and other files go out either way.
