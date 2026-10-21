# Automatic Photo Importer — consolidated user requirements

Compiled: 20 October 2026, America/Toronto.

This document consolidates the user-authored requests, clarification answers, and operational constraints available in this conversation. Repeated requests are combined without dropping their intent. Earlier requests that changed are retained in the change history. This is a requirements inventory, **not an implementation-completion report**. Existing code, assistant interpretations, test results, and ambient browser context do not establish new user requirements.

The original prompts mix English and Chinese. Requirements below are normalized into English; exact names, paths, and consequential Chinese instructions are preserved where useful. “Must” describes the requested behavior, rather than a claim that every scenario is already supported.

## Contents

1. [Project and platform](#1-project-and-platform)
2. [Research and development process](#2-research-and-development-process)
3. [Sources and camera detection](#3-sources-and-camera-detection)
4. [Destinations and first launch](#4-destinations-and-first-launch)
5. [Media discovery and unknown formats](#5-media-discovery-and-unknown-formats)
6. [Metadata, dates, and exposure](#6-metadata-dates-and-exposure)
7. [Paths and organization rules](#7-paths-and-organization-rules)
8. [Copying, queueing, and multiple disks](#8-copying-queueing-and-multiple-disks)
9. [Recovery, integrity, and filename conflicts](#9-recovery-integrity-and-filename-conflicts)
10. [Interface and settings](#10-interface-and-settings)
11. [Localization and icon](#11-localization-and-icon)
12. [Architecture review](#12-architecture-review)
13. [Testing and Codex integration](#13-testing-and-codex-integration)
14. [Actual A006 operations and safety boundaries](#14-actual-a006-operations-and-safety-boundaries)
15. [Read-only follow-up constraints](#15-read-only-follow-up-constraints)
16. [Changes and unresolved scope](#16-changes-and-unresolved-scope)
17. [Standing collaboration preferences](#17-standing-collaboration-preferences)
18. [This documentation request](#18-this-documentation-request)

## 1. Project and platform

- **PROJ-01:** Create a new project repository called **automatic photo importer**.
- **PROJ-02:** Make the repository public and pull/clone it locally.
- **PROJ-03:** Build from the supplied feature requirements immediately. The user explicitly chose “Start building from my requirements” instead of waiting for design approval.
- **PROJ-04:** Initially deliver the app for macOS. The original request specified SwiftUI and relevant SwiftUI skills.
- **PROJ-05:** Subsequently use a frontend platform that actually supports multiple operating systems. The current implementation must be multiplatform, rather than only having a future-compatible visual design.
- **PROJ-06:** Keep the interface substantially consistent across macOS, Windows, and Linux.
- **PROJ-07:** Preserve appropriate system-native window controls. In particular, macOS must use its native close, minimize, and fullscreen controls. Small platform differences are acceptable.
- **PROJ-08:** The earlier request was to build macOS first and not build separate Windows/Linux apps yet. The later multiplatform requirement changes the implementation direction; see Section 16 for the remaining delivery-scope distinction.
- **PROJ-09:** Copy files to user-selected filesystem destinations. A photo-library/catalog import inside the app is not required.

## 2. Research and development process

- **DEV-01:** Research similar projects on GitHub and learn from their code and approaches.
- **DEV-02:** Consult Chat/ChatGPT about comparable camera detection, import, and other relevant implementations.
- **DEV-03:** Research existing shutter-count projects and learn how they extract camera-specific counters.
- **DEV-04:** Investigate metadata problems similar to the Sony MP4 `DeviceModelName` problem, identify a solution, and cover comparable problems for other camera brands.
- **DEV-05:** Study Lightroom’s fast discovery experience and open-source photo applications’ import implementations. Optimize discovery without requiring an internal catalog.
- **DEV-06:** Use Matt Pocock skills and other relevant development, SwiftUI, and design skills as applicable to the selected implementation.
- **DEV-07:** Install suitable UI/design skills from GitHub when needed for the requested interface work.
- **DEV-08:** Use multiple ChatGPT consultations/chats when useful; do not force every research question into one chat.
- **DEV-09:** Offload outstanding work into **three separate chats** with nonoverlapping responsibilities when requested.
- **DEV-10:** Check all three chats’ progress and make sure they coordinate.
- **DEV-11:** Wait until the delegated chats finish, integrate their changes, and test the integrated result without deleting existing files.
- **DEV-12:** After the delegated work finishes, perform the requested full interface overhaul using relevant design skills.
- **DEV-13:** Automatically perform the requested architecture review, documentation, fixes, feature comparison, and validation without routine approval stops.
- **DEV-14:** Use similar applications as frontend design references; retain the user’s requested custom, clear, interactive interface.
- **DEV-15:** Investigate and fix the reported repeated app crashes (“the app crashes both times”).
- **DEV-16:** The user requested automatic approval of computer use for new apps. This expresses a preference for autonomy; it does not override host permission or confirmation rules.

## 3. Sources and camera detection

- **SRC-01:** Detect camera removable media automatically when connected to the computer.
- **SRC-02:** Aim to support camera media regardless of its connection/form factor. The user’s original wording was “no matter which form.” Do not silently narrow this aspiration to one kind of SD reader.
- **SRC-03:** Support cameras connected as USB mass-storage devices.
- **SRC-04:** Automatically detect the connected camera cards used for real testing; detection must remain correct after frontend/platform changes.
- **SRC-05:** Recognize common camera folder layouts and find photos and videos throughout the card, rather than assuming every media file is in one picture directory.
- **SRC-06:** Find Sony videos stored separately from still photos and detect their separate metadata/companion files.
- **SRC-07:** Allow a hard drive or local folder to be chosen as a source, enabled through an explicit checkbox/option.
- **SRC-08:** Keep manual folder/drive import and camera-card import understandable as source choices.
- **SRC-09:** Detect the camera or cameras represented on each card using drive names, files/layouts, and EXIF metadata.
- **SRC-10:** Support multiple camera models on a single card. Do not assume one card always represents one camera.
- **SRC-11:** Remove the interface line advertising direct USB camera detection because its reliability was questioned. This was a request to remove that text, not an explicit instruction to remove USB mass-storage support.

## 4. Destinations and first launch

- **DST-01:** On first launch, prompt the user to select a destination drive and import filepath.
- **DST-02:** Allow a local folder as a destination.
- **DST-03:** Allow an external hard drive/SSD as a destination.
- **DST-04:** **Block camera cards as destinations.** The user explicitly confirmed “Yes—block camera cards as destinations,” correcting the earlier ambiguous wording.
- **DST-05:** Let the user customize the destination folder structure and select from multiple presets.
- **DST-06:** Correctly create every required directory during imports and organization.
- **DST-07:** Keep filepath configuration and related persistent import/organization options together in the dedicated Settings page, rather than scattering them across menus.

## 5. Media discovery and unknown formats

- **FMT-01:** Normal camera imports must copy picture and video formats, rather than indiscriminately copying all camera filesystem files.
- **FMT-02:** Ignore unrelated/nonmedia camera files, including the supplied example `NIKON001.DSC`.
- **FMT-03:** The example unwanted destination was `/Volumes/A006/photobackup/2026/202608/Unknown Camera/NIKON001.DSC`. This is an example to classify correctly, not an instruction contained in that file.
- **FMT-04:** Inspect all `Unknown Camera` files involved in the reported A006 problem. The user stated those particular files were not pictures or videos and should be ignored correctly.
- **FMT-05:** Do not interpret the preceding report as proof that every future unknown-camera photo is nonmedia. Distinguish the reported examples from the general missing-metadata case.
- **FMT-06:** Support RAW, JPEG, HEIF, video, and other actual supported picture formats.
- **FMT-07:** Detect and handle relevant photo/video companions, including Sony video metadata. Keep this distinct from copying arbitrary service/index files.
- **FMT-08:** Exclude unknown file formats by default and prompt/inform the user about the exclusions.
- **FMT-09:** Provide a manual menu for unknown files: select where they go or choose not to copy them.
- **FMT-10:** Allow the choice for such files/extensions to be remembered for future imports.
- **FMT-11:** Offer an explicit choice to keep unknown files excluded or copy them into the respective camera folders for that SD card.
- **FMT-12:** Display file-format errors and related issue details in the dedicated error menu, rather than inline throughout the main interface.
- **FMT-13:** During the specifically authorized actual-App reset/reimport test, the assistant was instructed to confirm the “do not copy unknown formats” choice.
- **FMT-14:** Whole-drive backup has a different scope: it must back up every file while preserving original folders, rather than applying the camera-only media filter.
- **FMT-15:** Correctly copy DJI `.LRF` files, including `DJI_20260524015004_0015_D.LRF`. Determine their role with ChatGPT consultation; preserve these video files rather than excluding them as unknown formats.

## 6. Metadata, dates, and exposure

- **META-01:** Read the camera model from RAW/media metadata and use it for camera-based organization.
- **META-02:** Correctly identify camera names in videos as well as photos, including Sony MP4 XML using `DeviceModelName`.
- **META-03:** Investigate analogous model/date metadata variations for other cameras, instead of fixing only the single Sony example.
- **META-04:** Take account of a timezone when it exists in the file metadata.
- **META-05:** Display capture dates and times in a readable form, with date/time and timezone separated.
- **META-06:** The provided capture display example was `2025-06-26T13:50:35+08:00`. This is an example timestamp, not a task deadline.
- **META-07:** Provide a detailed EXIF/metadata display panel/bar.
- **META-08:** Show lens, aperture, ISO, shutter speed, and other important exposure metrics.
- **META-09:** Keep all metadata compact/collapsed by default; require a click to expand its menu.
- **META-10:** Add a metadata-based shutter-count checker, informed by existing projects.
- **META-11:** Do not display shutter count for videos.
- **META-12:** A photo preview feature was originally requested. The later request to remove the preview-photo option must also be preserved; see Section 16 instead of treating the earlier preview request as unqualified current scope.

## 7. Paths and organization rules

- **ORG-01:** Default to the selected drive followed by `photobackup/year/yyyymm/devicename`.
- **ORG-02:** Use a camera name derived from the media metadata for `devicename`.
- **ORG-03:** Make the path customizable and provide several presets.
- **ORG-04:** Offer optional RAW/JPEG/video/HEIF separation into their own subfolders within the camera’s organization structure.
- **ORG-05:** Recheck existing files in their intended destination folders during imports and avoid unnecessary duplicate copying.
- **ORG-06:** Provide an in-app action/button to organize files already on a destination drive when they are in incorrect folders.
- **ORG-07:** Apply changes the user makes to folder organization rules to existing files through that organization action.
- **ORG-08:** Correct incorrect camera-folder names by moving their media into the correctly named camera folder.
- **ORG-09:** Correctly merge overlapping destination folders and existing content.
- **ORG-10:** Remove obsolete original camera folders after their contents have been safely moved. Never remove them prematurely or discard remaining contents.
- **ORG-11:** Preserve data redundancy during organization. Do not delete originals before moves/copies have completed and been checked.
- **ORG-12:** Organization must be recoverable/recheckable/resumable after interruptions, including power loss.
- **ORG-13:** Implement and test the app’s one-click organization feature **before** using it for the requested A006 root-year reorganization.
- **ORG-14:** Organize `/Volumes/A006/2024/`, `/Volumes/A006/2025/`, and `/Volumes/A006/2026/` into their correct `photobackup` destinations.
- **ORG-15:** Distinguish photo-editor exports from unedited originals, including exports made by Lightroom and other photo editors.
- **ORG-16:** Put edited exports in a separate folder within each month, rather than mixing them with unedited pictures.
- **ORG-17:** The requested default edited-folder spelling is **`editied`**, exactly as supplied. Allow the user to change it.
- **ORG-18:** Explicit clarification: **only editor-exported finished images** go into `editied`; RAW originals and their XMP files remain together in the original-media directory.
- **ORG-19:** Do not classify a RAW original as an edited export merely because Lightroom stores adjustments in an associated XMP file.
- **ORG-20:** Execute the requested real organization through the actual app and its one-click function, rather than substituting an external maintenance command for app functionality.

## 8. Copying, queueing, and multiple disks

- **COPY-01:** Provide explicit Start and Stop controls.
- **COPY-02:** Provide an Automatic import control.
- **COPY-03:** Automatically import from newly detected camera media when automatic mode is enabled and a destination is configured.
- **COPY-04:** Support up to **five sources copying concurrently**.
- **COPY-05:** Queue additional sources.
- **COPY-06:** Let the user change parallel-source count using a slider.
- **COPY-07:** Put that slider on the same heading row as the small **Sources & queue** title.
- **COPY-08:** Support two destination disks, with both requested destination modes selectable.
- **COPY-09:** Support redundant copies on the two selected destinations and sequential/fill-first-then-second writing. The original “parady/parity” wording and unresolved true-parity distinction are recorded in Section 16.
- **COPY-10:** Provide drive-to-drive backup as a separate use case.
- **COPY-11:** For drive-to-drive backup, offer mirroring and a filling/additive mode.
- **COPY-12:** In the additive mode, do not delete files from the second drive when they have been deleted from the first drive. Delete those retained files only through manual deletion.
- **COPY-13:** For drive-to-drive backup, copy **every file and preserve the folder structure**, as explicitly clarified by the user. Do not restrict this mode to date/camera-organized photo/video files.
- **COPY-14:** Make copying quicker by copying first and validating afterward as separate phases, rather than interleaving file-copy and validation passes. Retain the integrity and recovery protections below.

## 9. Recovery, integrity, and filename conflicts

- **SAFE-01:** Do not lose, corrupt, or incorrectly delete any files during copying, merging, organization, or recovery.
- **SAFE-02:** Retain a recoverable original/redundant copy until the new destination is complete and verified.
- **SAFE-03:** Handle drive removal during copying and allow the situation to be checked/recovered from.
- **SAFE-04:** Handle sudden process interruption/power loss and support a recheck or resume.
- **SAFE-05:** Detect half-copied files, including those left by power loss, and continue/complete the intended file instead of blindly creating another copy.
- **SAFE-06:** The user specifically requested continuing an interrupted file “to overwrite.” This must be reconciled with SAFE-01/02: partial recovery must not become permission to overwrite unrelated complete or different-content user files.
- **SAFE-07:** Detect duplicate filenames separately from duplicate contents.
- **SAFE-08:** If filenames are the same but contents differ, preserve both and place the newer/incoming files in another folder **within that camera folder**.
- **SAFE-09:** Check the current running app’s status and its run errors, and add prevention for errors discovered in that inspection.
- **SAFE-10:** Do not equate passing unit tests or matching file counts with a complete no-loss verification of the actual drive contents.
- **SAFE-11:** Keep recovery copies when the user asks to retain them. Specific later deletion authorization for the old `photobackup` tree is a scoped exception, not a universal cancellation of this protection.
- **SAFE-12:** Copied photo/video files should display the capture date in filesystem Created and Modified dates rather than the copying time. Preserve original file contents without conversion and retain the existing source-file safety constraints.

## 10. Interface and settings

### General design

- **UI-01:** Fully overhaul the frontend using relevant design skills.
- **UI-02:** Use a custom, pronounced, interactive interface, rather than only default SwiftUI styling.
- **UI-03:** Use bigger buttons and clearer instructions.
- **UI-04:** Use larger, more readable text by default, with a user-adjustable text size.
- **UI-05:** Provide a dedicated Settings page.
- **UI-06:** Define a theme/accent color.
- **UI-07:** Support dark and light modes, with **Follow system** as the default.
- **UI-08:** Make the interface scalable and responsive to available space.
- **UI-09:** Offer source cards in a **two-column grid** or a **one-column list**.
- **UI-10:** Keep the shared frontend’s appearance substantially consistent across macOS, Windows, and Linux, while allowing native window controls and small OS differences.

### Dashboard and source cards

- **UI-11:** Replace the large “Ready for your next shoot. Choose a destination, connect your camera, then start importing.” hero/title with a useful dashboard.
- **UI-12:** Show useful copy statistics, including copying speed, number of drives copying, and drive status.
- **UI-13:** Provide a clear interface for multiple connected drives.
- **UI-14:** Show sources as separate cards, not one big menu block.
- **UI-15:** Make each source card compact and reduce its height.
- **UI-16:** Improve stacking and organization of the cards.
- **UI-17:** Add a details-expansion button/disclosure per card; keep details collapsed by default.
- **UI-18:** Show a drive-capacity bar.
- **UI-19:** Show drive name and filesystem path.
- **UI-20:** After scanning, show only actual picture/video formats in the drive’s media-format summary.
- **UI-21:** Show picture/video counts separated by format, and their total size.
- **UI-22:** Show the camera or multiple cameras represented on the drive, using drive-name/file/EXIF evidence.
- **UI-23:** **Historical, superseded by UI-41:** Add a **pie chart** in the details panel. The prompt spelled this “pi chard.” A particular chart measure was not specified by the user; the implemented media-by-format storage interpretation is not itself an additional user requirement.

### Navigation, title bar, and actions

- **UI-24:** Reorganize button placement using Matt-related design/engineering guidance.
- **UI-25:** Place Start, Stop, and Automatic controls in the upper title bar.
- **UI-26:** Provide a title-bar button for total progress.
- **UI-27:** Provide a title-bar button for all errors.
- **UI-28:** Display errors in a separate error section/menu, not in the main interface.
- **UI-29:** Put page titles such as **Import desk** in that same upper title bar alongside the buttons, rather than in another title row.
- **UI-30:** Make Automatic a **button-shaped toggle**.
- **UI-31:** Extend the left sidebar to the very top of the window.
- **UI-32:** Remove the preview-photo option, per the later request; preserve the ambiguity about removing every preview versus removing its entry control in Section 16.
- **UI-33:** Remove the unreliable direct-USB-detection advertising line.

### Settings consolidation and motion

- **UI-34:** Make Settings compact.
- **UI-35:** Move the filepath configurator into Settings.
- **UI-36:** Move related persistent options into Settings rather than scattering them across menus. This includes the path/organization configuration discussed in the preceding prompts.
- **UI-37:** Add animations for menu interactions, popups, clicks, and interface changes.
- **UI-38:** Preserve readable, usable controls while adding custom layouts and motion. Specific timings, libraries, and reduced-motion behavior were implementation choices, not numeric requirements supplied by the user.
- **UI-39:** Display capacity bars similar to the supplied macOS Storage screenshot: a continuous segmented strip, readable used/total and available capacity, and a category legend.
- **UI-40:** Use separate colors for individual image and video file formats, rather than only broad image/video categories.
- **UI-41:** Remove the previously requested pie chart. Retain the capacity strip and format information.

## 11. Localization and icon

- **LOC-01:** Translate the interface into four languages.
- **LOC-02:** The explicitly selected languages are **English, Simplified Chinese, Traditional Chinese, and Japanese**.
- **LOC-03:** Apply the four-language requirement to later-added features and drive information as well, rather than only the initial screens.
- **ICON-01:** Create an app logo using Apple’s provided logo/icon creator.
- **ICON-02:** Prevent highlights from spilling outside the designed icon: “设计的logo不要有高光部分溢出的问题.”
- **ICON-03:** Check the icon’s visual balance: “并且进行平衡度检查.”
- **ICON-04:** Use the logo already in the project as the app's logo, including the packaged application icon and in-app branding.

## 12. Architecture review

The following review/fix request was repeated, including an explicit instruction to compare the code with the requested feature set.

- **ARCH-01:** Inspect the repository and inventory its actual functional interfaces.
- **ARCH-02:** Map each interface/function to its actual implementation and summarize the complete inventory in documentation.
- **ARCH-03:** Keep one authoritative implementation for a function; do not implement redundant versions or unnecessary alternative styles.
- **ARCH-04:** Think from first principles about the required behavior and the overall architecture.
- **ARCH-05:** Avoid redundant abstractions and unnecessary fallback layers.
- **ARCH-06:** If A and B solve the problem, do not split it needlessly into A, B, C, and D. The user described that as “臭抽象.”
- **ARCH-07:** Identify components placed in inappropriate architectural layers.
- **ARCH-08:** Identify repeated data transfer between layers, redundant interfaces, and associated performance costs.
- **ARCH-09:** Use Matt skills for the review.
- **ARCH-10:** Fix the problems identified in the report automatically, rather than only delivering an audit.
- **ARCH-11:** Check the actual implementation against the full user-requested feature set.
- **ARCH-12:** Preserve meaningful data redundancy for file safety while removing unnecessary software/interface redundancy. These are separate requirements.
- **ARCH-13:** The later explicitly requested grid/list presentations remain valid UI choices; they do not require two separate copying or scanning implementations.

## 13. Testing and Codex integration

- **TEST-01:** Perform a full code/edge-case review, consulting Chat and using Matt and other relevant skills.
- **TEST-02:** Perform full tests of the app and the integrated changes, as requested repeatedly.
- **TEST-03:** Test with the connected real SD cards and removable SSD, which already have an existing folder structure.
- **TEST-04:** Use the real hardware to test importing and the actual app workflow.
- **TEST-05:** Do not delete existing files in the initial hardware tests.
- **TEST-06:** Never delete files from the camera SD cards, including after A006-specific deletion authorization was later given.
- **TEST-07:** Test failure modes including unplugging a drive during copying, power loss/process interruption, corrupt files, and other errors.
- **TEST-08:** Consult Chat to help identify failure modes.
- **TEST-09:** Check whether old maintenance is making progress rather than stuck before continuing the year-folder work.
- **TEST-10:** Complete a comprehensive final verification after organizing 2024/2025/2026, checking for lost or incorrectly deleted files.
- **TEST-11:** Retain recovery copies during the requested verification, subject to later narrowly scoped reset authorization.
- **TEST-12:** Build Codex integration/testing support so the app can be tested faster.
- **TEST-13:** Confirm real camera detection, correct folder creation, merges, format handling, and recovery through app behavior, not merely through UI appearance or assistant claims.
- **TEST-14:** Keep the existing A006 downloads running and consolidate stable files only; the user explicitly chose this instead of pausing Baidu Netdisk.
- **TEST-15:** The user agreed to manually unlock the Mac when it was blocking native UI/preview verification. This was a one-time operational reply, not a requirement to bypass locking or authentication.
- **TEST-16:** Build the final release version and test it with the connected SD cards. The later clarification for this run is **“修复app，不做文件整理测试，只做相机导入测试”**: fix the app and perform camera-import testing only; do not perform file-organization tests in this run.

## 14. Actual A006 operations and safety boundaries

These are **specific operational instructions**, not blanket permissions for arbitrary future app deletion.

### Initial organization and preservation

- **A006-01:** Inspect the connected SD cards and A006 SSD as real test hardware, preserving their existing structure/files unless later specifically authorized.
- **A006-02:** Check the current progress of the existing A006 maintenance work and confirm that it is not stuck.
- **A006-03:** Wait for the old maintenance to finish before continuing the root `2024`, `2025`, and `2026` organization.
- **A006-04:** Continue and finish that year-folder organization, then perform final comprehensive verification.
- **A006-05:** Keep recovery copies as explicitly requested.
- **A006-06:** Earlier A006 cleanup authorization allowed deletion **on A006 only**: “can delete the files in a006, and a006 only.”
- **A006-07:** Remove duplicates and merge the relevant A006 material, without incorrectly deleting any files.
- **A006-08:** Do not delete any camera SD-card files. Test imports using that real hardware.
- **A006-09:** Keep downloads running and consolidate stable files only, per the clarification answer.

### Transition to testing through the app

- **A006-10:** Launch the actual app and use its one-click organization: “需要让app帮我整理，启动app并一键整理.”
- **A006-11:** Delete/reset the existing `photobackup` tree as specifically requested, then let the actual app automatically reimport camera-card media.
- **A006-12:** Confirm the unknown-format exclusion choice during that real app test.
- **A006-13:** Use the app itself to organize root A006 `2024`, `2025`, and `2026` into `photobackup`. These capabilities must be actual app functionality.
- **A006-14:** Detect the already-connected camera drives automatically for this workflow.
- **A006-15:** The most specific reset instruction was **“直接永久删除photobackup文件夹，除了edited文件之外。”** Permanently delete the old `photobackup` folder **except edited files**.
- **A006-16:** Preserve edited exports during that reset. The wording `edited` in this deletion exception does not cancel the earlier default folder-name requirement `editied`.
- **A006-17:** Do not interpret permission to remove the old `photobackup` tree as permission to delete root-year originals, the new rebuilt library, camera cards, or unrelated files.
- **A006-18:** Check the current running app and its error menu without substituting code-level test results for its actual status.

## 15. Read-only follow-up constraints

The user-provided heartbeat messages define the scope of the A006 progress automation. These instructions apply to those follow-ups, not as authorization to launch additional business work.

- **MON-01:** Read `build/media-organization-audit/tracking.json` first to identify the current run, process, audit directory, and phase.
- **MON-02:** Follow only the current `followup`/`finalAudit` or current actual-App run identified by tracking.
- **MON-03:** Only inspect existing process identity, logs, JSON receipts, actual App operation reports, and current audit evidence.
- **MON-04:** Do not launch, resume, change, copy, move, delete, clean, or finalize business work from the read-only follow-up.
- **MON-05:** Do not click app action buttons or modify app settings, media, or code from that automation.
- **MON-06:** Treat superseded/cancelled old waiting tasks as intentionally cancelled, not as new data failures.
- **MON-07:** Recognize that the old 27,189/27,189 recovery verification completed before an intentional abort to preserve originals. Its `passed=false Abort` summary must not be misreported as a content-check failure.
- **MON-08:** Do not rerun the old automatic-finalize script.
- **MON-09:** Respect the `verified-retained` predecessor checkpoint and its bindings to original execution, verification, exit, and signal records when interpreting that stage.
- **MON-10:** In the retained-copy stage, limit follow-up scope to 2024/2025/2026/photobackup and preserve the two required recovery generations.
- **MON-11:** Independently verify canonical destinations and required retained originals by individual path, existence, size, and SHA-256, including the old/new plans and the 7,954 recorded imported contents. Counts or unit tests alone are insufficient.
- **MON-12:** After the later actual-App reset superseded the old CLI work, do not restart that CLI follow-up or its old waiting auditor.
- **MON-13:** Interpret the recorded 19,227 restored historical originals and 786 preserved edited exports using their reset/preservation receipts; do not confuse those receipts with permission to initiate more work.
- **MON-14:** For the actual-App phase, use actual `operation-reports` plans, executions, results, current audit reports, and existing logs.
- **MON-15:** Keep quiet if the state is unchanged and no action is needed.
- **MON-16:** Notify only on a real phase change, genuine failure, required user action, or completed final content verification; link the relevant report.
- **MON-17:** Close the read-only follow-up after current organization and independent verification are complete and have been reported.

## 16. Changes and unresolved scope

Later explicit user clarifications take precedence where there is a direct conflict. An assistant implementation choice is not a user clarification.

| Topic | Earlier request | Later instruction / current reading |
|---|---|---|
| Development approval | Prepare a design or begin implementation | User chose **start building from the requirements**. |
| Technology | macOS-only SwiftUI initially | User later required a **multiplatform implementation and frontend**. Shared multiplatform implementation supersedes a SwiftUI-only product. |
| OS releases | Design for Windows/Linux but do not make those apps yet | Later requirement makes the implementation multiplatform. Whether separate Windows/Linux packages must be released immediately was not explicitly restated. |
| What camera import copies | “Import all files in the camera” | Later narrowed to **picture/video formats**, legitimate companions, and explicit unknown-format choices. Whole-drive backup still requests every file. |
| Camera card destination | Ambiguous “should absolutely select” wording | Explicit answer: **block camera cards as destinations**. |
| Unknown formats | Manual destination/skip menu | Default exclusion plus optional respective-camera-folder copying and remembered choices; put issue handling in the dedicated error menu. |
| Photo preview | Add preview functionality | Later: **“remove the preview photo option.”** Removal of that visible option is requested. The user did not explicitly clarify whether every per-file/inline preview must also be removed; do not present a global-button-only interpretation as confirmed. Detailed EXIF remains requested. |
| USB messaging | Support connected camera media and mass storage | Remove the unreliable direct-USB-detection text; mass-storage support remains required. |
| Metadata presentation | Detailed EXIF bar | Readable date/time and separate timezone, exposure summary, full metadata collapsed, no video shutter count. |
| Source presentation | A unified interface for multiple drives | Separate compact cards, collapsed details, then selectable two-column grid or one-column list. |
| Top controls | Start/Stop/Automatic | Same title-bar row as page title; total-progress and errors buttons; button-shaped Automatic toggle; full-height left sidebar. |
| Settings | Dedicated Settings page | Compact Settings; move filepath configurator and related persistent options there. |
| Edited classification | Separate editor-edited media | Explicitly **editor-exported finished images only**; keep RAW+XMP with originals. Default folder spelling **`editied`**, user configurable. |
| Testing deletion | Do not delete existing files | Later authorized deletion on **A006 only**, then specifically permanent deletion of old **photobackup except edited files**. Camera-card deletion remains forbidden. |
| Recovery retention | Keep recovery copies / two generations | Specific old-backup reset authorization supersedes retention for that old reset tree only; it is not a blanket cleanup instruction. |
| Execution mechanism | Maintenance and verification running in background | User later required **the actual app’s one-click organization and automatic import** for the requested real test. |
| Downloads | Pause or continue Baidu Netdisk | User explicitly selected **keep downloads running; stable files only**. |
| Two disks / “parady” | “Parady or sequential write” | User wanted both offered options selectable. Redundant two-disk copying and sequential filling are the working interpretation; **a mathematical parity/RAID/erasure-coding scheme was never specified**. Do not claim a confirmed parity design. |
| Drive-to-drive modes | Mirror or filling | Both remain requested. Additive mode explicitly keeps second-drive files after first-drive deletions. Exact destructive mirror deletion semantics and approval behavior were not fully specified; this must not be silently treated as already implemented deletion synchronization. |
| Same-name files | Detect duplicates and merge safely | Later explicitly distinguish same name/different content and put the newer/incoming copy in another camera subfolder. **`Conflicts`**, hashes, and the exact naming scheme are implementation choices, not user-specified folder names. “Newer” was not explicitly defined as capture time, modification time, or arrival order. |
| Pie chart | Add a “pi chard” to details | Later explicitly **remove the pie chart**. Capacity bars must distinguish individual picture and video formats by color. |
| Failure testing | Include power-loss cases | Desired capability remains. Process-kill tests do not by themselves establish physical power-loss qualification. |

## 17. Standing collaboration preferences

These user-supplied AGENTS instructions are workflow requirements, not end-user app features.

- **WORK-01:** Apply the GPT model-router skill in every conversation/task; read it once per session and reuse the instructions.
- **WORK-02:** Use supported model/effort settings for useful bounded delegation. Do not claim a main-chat model switch without an actual supported operation confirming it.
- **WORK-03:** Apply the Grok-delegate skill; prefer suitable bounded reading, mechanical edits, and consultations through Grok 4.7 at `xhigh`, within host permissions. Codex owns integration and validation.
- **WORK-04:** Answer trivial or tightly serial tasks directly when delegation adds no value; delegation is not mandatory for every prompt.
- **WORK-05:** Apply the Superpowers framework and relevant debugging, testing, planning, review, and verification practices proportionately.
- **WORK-06:** Read the Matt Pocock skill catalog once per chat, select relevant skills, and reuse already-read instructions.
- **WORK-07:** Preserve user changes and working code. Do not delete code merely because it predates a test.
- **WORK-08:** Prefer meaningful behavioral/regression tests for substantive changes. Avoid tests that only mirror implementation or unnecessarily test reversible low-impact edits.
- **WORK-09:** Run required checks proportionately, report failures and limitations honestly, and reuse valid evidence when relevant code has not changed.
- **WORK-10:** Avoid speculative retries, validation, monitoring, unrelated refactors, and unnecessary approval gates.
- **WORK-11:** Continue already-authorized work; ask only for genuinely missing information or permission and continue independent useful work while a question is pending.
- **WORK-12:** Skill use alone does not authorize commits, pushes, merges, publishing, sending messages, creating issues, destructive cleanup, or sharing transcripts.
- **WORK-13:** Use native managed worktree tools when useful, preserving existing isolation and following host instructions.
- **WORK-14:** Compose overlapping skills into one proportionate workflow. Do not automatically create issue trackers/spec publications or change unrelated project configuration.
- **WORK-15:** Higher-priority host instructions, available tool schemas, permissions, and explicit user overrides remain authoritative.

## 18. This documentation request

- **DOC-01:** Consolidate the requirements from **all available user prompts** into a **single document**.
- **DOC-02:** Give the user its filesystem path.

Compilation rules used here: preserve clarifications, changes of direction, task-specific permissions, and unresolved ambiguities. Keep requirements separate from completion claims; implementation/audit reports provide evidence of what actually works. These rules describe how this document was prepared, rather than adding new app requirements.

## Related implementation evidence (not additional requirements)

- [Architecture and actual interfaces](architecture-and-features.md)
- [A006 organization and operational record](media-organization-20261020.md)
- [Recovery implementation and verification](organization-recovery.md)
- [Failure-mode test record](failure-modes-20261020.md)
- [Codex testing](codex-testing.md)

This inventory is based on the conversation available at compilation time. It does not claim access to prompts from other chats that are not present here. New user requirements should be added with their scope and any superseded direction made explicit.
