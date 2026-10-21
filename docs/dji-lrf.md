# DJI LRF import handling

Verified against [DJI’s LRF explanation](https://repair.dji.com/help/content?customId=01700006938&lang=en&paperDocType=ARTICLE&re=US&spaceId=17) on 20 October 2026, America/Toronto.

DJI describes LRF as compressed video used for playback, preview and DJI Mimo’s Trim Download function. Its guidance says removing the LRF affects camera playback of the related recording. A surviving LRF can provide a low-definition recording; it does not replace the full-resolution original.

The importer therefore includes LRF as video by default, keeps its extension and contents, and copies standalone LRF files too. A unique same-stem original video in the same directory supplies camera/date routing and a shared conflict family when the proxy lacks its own metadata. Ambiguous matches remain independent, importable videos. No timezone is inferred from the filename. Paired proxy video remains visible in the capacity format summary.

The [requested ChatGPT Pro consultation](https://chatgpt.com/c/6ad805a7-03ac-83ea-b03f-81fdb6c47e89) recommended default inclusion, unchanged names/bytes, conservative pairing, and standalone preservation. These recommendations were checked against DJI’s primary source and local regressions. ChatGPT did not inspect the local file or execute tests.

Regression coverage is in `desktop/tests/dji-lrf.test.ts`: byte-identical standalone copying, old exclusion-rule override for recognized video, mixed-case paired extensions, same-directory routing, ambiguous/cross-directory isolation, and visible proxy format information. The supplied path `/Volumes/A006/2026/202605/P3/DJI_20260524015004_0015_D.LRF` was unavailable at inspection time, so its actual codec, timestamps and content have not been certified. No files on A006 or camera cards were changed.
