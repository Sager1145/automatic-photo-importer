# 相机型号、拍摄日期和时区字段研究

日期：2026-10-20。范围：ExifTool 实际输出字段与本项目的读取策略，不根据品牌、文件名或电脑时区猜测拍摄信息。核对了官方源码及本机随项目安装的 ExifTool 13.59 源码；仅阅读源码，没有读取相机卡或修改媒体。本次只补这份研究文档，代码验证结果由实现任务另行记录。

## 直接影响当前实现的结论

1. `Composite:SubSecDateTimeOriginal` 比普通 `EXIF:DateTimeOriginal` 包含更完整的信息。ExifTool 将后者与 `SubSecTimeOriginal`、`OffsetTimeOriginal` 组合；`SubSecCreateDate` 对应 `CreateDate`、`SubSecTimeDigitized`、`OffsetTimeDigitized`。仅选普通日期会丢失小数秒和已有偏移。完整 composite 仍须与其原始日期、同源配对子字段一致；本项目保留明确记录的原始值和唯一配对子字段，再用不冲突的 composite 补全。不能把 Original 的偏移接到 Digitized 日期上。[官方 Composite 文档源码](https://raw.githubusercontent.com/exiftool/exiftool/master/html/TagNames/Composite.html)、[Exif.pm 的 composite 定义](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Exif.pm)
2. 视频的 `Keys:CreationDate` 和整数容器 `QuickTime:CreateDate` 不是同一字段。Apple 将前者定义为电影内容的创建日期；ExifTool 的 Keys 表把 `com.apple.quicktime.creationdate` 解码成 ISO 8601 `CreationDate`。有明确偏移的内容日期应优先于没有偏移的容器日期，这是本项目的选择策略。[Apple 内容创建日期](https://developer.apple.com/documentation/avfoundation/avmetadataidentifier/quicktimemetadatacreationdate)、[ExifTool QuickTime.pm Keys 表](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/QuickTime.pm)
3. QuickTime 整数日期按规范应为 UTC，但真实相机也会写本地时间。ExifTool 默认不假设其时区；开启 `QuickTimeUTC` 才按 UTC 解释并转换到本地。不能为“补时区”而全局开启它，也不能给无偏移日期附加电脑时区。[ExifTool 官方 QuickTime 文档，日期说明](https://raw.githubusercontent.com/exiftool/exiftool/master/html/TagNames/QuickTime.html)、[Apple movie header creation time](https://developer.apple.com/documentation/quicktime-file-format/movie_header_atom/creation_time)
4. 同名 `TimeZone` 不具有统一数值语义。Nikon 同时存在分钟偏移和型号专属枚举；Canon、GoPro 也有自己的记录结构。不能只按字段名末尾找到一个数字就解释成分钟。[Nikon.pm](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Nikon.pm)、[Canon.pm](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Canon.pm)、[GoPro.pm](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/GoPro.pm)

## 型号字段：使用已解码的型号，不扩充泛化别名

`Model` 是跨品牌、跨 EXIF/XMP/QuickTime 的主要已解码字段。保留 group，按明确来源选择非空字符串；不要将数字、数组或对象直接 `String()` 成型号。`Make` 是厂商，不是型号；打印描述“Camera Model Name”也不等于实际标签名就是 `CameraModelName`。[标准 EXIF 定义](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Exif.pm)、[XMP TIFF Model 定义](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/XMP.pm)

| 来源 | 经过核对的可用字段 | 不应自动当作型号的字段/原因 |
|---|---|---|
| Canon | 标准 `Model`；QuickTime Canon 记录也解码为 `Model` | `CanonModelID` 是需要解码的 ID；`CameraType` 区分 Compact、EOS High-end 等类别，不是具体型号。[Canon 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Canon.pm)、[QuickTime 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/QuickTime.pm) |
| Nikon | 标准 EXIF `Model` | 不能把序列号、固件型号判断条件、驱动标签当作另一组型号别名。[Nikon 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Nikon.pm) |
| Sony | 标准 `Model`；实际视频 XML 的 `DeviceModelName` | `SonyModelID` 在 `-n` 下仍是代码，不能输出为“相机型号”。Sony XML 读取示例明确把 `DeviceModelName` 映射到 `Model`、`CreationDateValue` 映射到 `CreationDate`，说明只读普通 Model 会漏掉 XML 信息；这不是所有 Sony 文件都必含这些字段的承诺。[Sony 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Sony.pm)、[ExifTool 项目论坛的原始 XML 处理记录](https://exiftool.org/forum/index.php?topic=15941.0) |
| Fujifilm | 标准 `Model`；FujiFilm RAF 头也有已解码 `Model` | `InternalSerialNumber` 中的制造日期不是拍摄日期，也不能据其中编号推型号。[FujiFilm 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/FujiFilm.pm) |
| Panasonic / Leica | 标准 `Model`；Leica/Panasonic 专有结构也解码成 `Model` | 无需复制 ExifTool 的相机表或靠 `.RW2` 推具体型号。[Panasonic 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Panasonic.pm) |
| Olympus / OM System | 标准或解码后的 `Model` | `CameraType` 是如 SX… 的内部代码，由 PrintConv 表解码；`-n` 读取时不能把原代码当作新型号名称。[Olympus 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Olympus.pm) |
| Pentax / Ricoh | 标准 `Model`；部分 Pentax 记录直接解码为 `Model` | `PentaxModelID` 需要映射，不是字符串型号。[Pentax 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Pentax.pm) |
| DJI | 照片：标准 `Model`（多为机身/镜头模组代码，如 Mini 3 Pro 的 `FC3582`、Pocket 3 的 `PP-101`）。视频：新款机型无顶层 `Model`，产品名在 `ItemList:Encoder`（个别在 `UserData:Encoder`），实测 `DJI OsmoPocket3`，另有报告 `DJI Mini4 Pro`、`DJI Mini5Pro`、`DJI OsmoAction4/5 Pro/6`、`DJI DJIMavic3 Enterprise`；旧款写 `Dji AVC Encoder`（编码器名，不是机型）。timed-metadata 的 `TrackN:Model` 需要 `-ee`，路由不读 | 路由读取 `Encoder`，只接受以 DJI 开头且不含 encoder/AVC/HEVC/H.26x 的值。照片代码与视频产品名会落到不同相机目录；没有官方的代码→产品名映射，暂不猜测。[DJI 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/DJI.pm)、[winnow PR #295](https://github.com/CostardRouge/winnow/pull/295)、[ChatGPT 调研](https://chatgpt.com/c/6ad9504a-6aec-83ea-8575-7fe30cd6d2b0) |
| GoPro | `Model`，包括 GPMF `MINF` 的解码结果 | `DeviceName` 还可能是 Camera、Global Settings、Highlights 或镜头/传感器名称，不能通用作型号。[GoPro 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/GoPro.pm) |
| Apple / QuickTime | `Keys:Model`；ExifTool 把 `com.apple.quicktime.model` 解码为 Model | 文件品牌、编码器软件名不是相机型号。[QuickTime Keys 定义](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/QuickTime.pm) |

没有证据支持给所有品牌追加通用 `ModelName`、`CameraType`、`DeviceName` 兜底。当前兼容别名 `CameraModelName`、`CameraModel` 可保留，但本次未发现它们能替代上表的主要已解码字段。Sony 的真实 XML 差异应精确加入 `DeviceModelName`，而不是让任意名字包含 Model 的标签都参与。

## 时区值的具体区别

| 字段/结构 | 已确认语义 | 本项目最小处理 |
|---|---|---|
| EXIF `OffsetTimeOriginal` / `OffsetTimeDigitized` / `OffsetTime` | 分别对应 DateTimeOriginal / CreateDate / ModifyDate | 只配对各自日期；严格校验 `±HH:MM`，保留原始偏移。[EXIF 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Exif.pm) |
| EXIF `TimeZoneOffset` | 一或两个有符号**小时**值，第一值对应 DateTimeOriginal，第二值对应 ModifyDate | 不能作为所有日期的分钟值。若实现须显式识别这个字段及数组形状，不能混进普通 TimeZone 规则。[EXIF 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Exif.pm) |
| Canon `TimeInfo:TimeZone` | 有符号分钟；另有 TimeZoneCity，DaylightSavings 的值为 0/60 | 单独 DST/城市值不足以证明是否已包含于拍摄偏移，不能盲加一次小时。[Canon TimeInfo 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Canon.pm) |
| Nikon `WorldTime:TimeZone` | 有符号分钟，另有 DaylightSavings 0/1 | Nikon Z9 等其他结构的 TimeZone 使用枚举表；只有 group 仍不能保证能区分同一品牌的不同结构，暂不通用解码。[Nikon WorldTime 与 TimeZone 表](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Nikon.pm) |
| Pentax WorldTime | Hometown/Destination 选择、两个城市及各自 DST 标志 | 不把城市 ID 当偏移，也不根据当代城市时区库猜旧照片时间。[Pentax 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Pentax.pm) |
| GoPro GPMF `TZON` | 解码为 TimeZone，分钟到时区字符串的转换 | 仍需确定它对应的具体拍摄日期，不能和任意 QuickTime 整数日期拼接。[GoPro 源码](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/GoPro.pm) |
| Sony XML CreationDate value | 实例含 ISO 日期及 Z/数字偏移，ExifTool 输出 CreationDateValue | 使用字段自身偏移，不根据卡名或另一文件推断。[ExifTool 原始样例记录](https://exiftool.org/forum/index.php?topic=15941.0) |
| Fujifilm / Panasonic / Olympus | 本次没有核实到可统一套用的额外 maker-note 时区算法 | 使用实际出现的标准 EXIF 偏移、带偏移内容日期；缺失就保持未知，不增加品牌猜测。各自型号来源见上表。 |
| DJI 视频 `QuickTime:CreateDate` + 文件名 `DJI_YYYYMMDDhhmmss_…` | CreateDate 无偏移，A006 上 Pocket 3 实测为 UTC（与文件名相差 +8、−4、−5 小时，偶有 1 秒差）；Mini 4 Pro、Mini 5 Pro、Action 5 Pro 的公开样本也相同。文件名是相机本地时间。有报告称部分固件把 CreateDate 记为片尾时间，初代 Mavic Mini 两者都不对 | 带时间戳的 DJI 文件名作为本地拍摄时间（仅当日期本来会取自无偏移的 QuickTime CreateDate）；两者相差整时区（±2 秒、≤14 小时）时附上该偏移，否则不带偏移；相差 0 时保持墙钟、不标 UTC。改名后的文件与 EXIF 日期不受影响。[Lightroom 已知问题](https://community.adobe.com/feature-requests-676/p-handle-video-capture-times-for-cameras-obeying-the-quicktime-mp4-standard-665608)、[ChatGPT 调研](https://chatgpt.com/c/6ad9504a-6aec-83ea-8575-7fe30cd6d2b0) |

## 建议的单一规范化策略

这是本项目的实现建议，不宣称来源规范规定了跨容器优先顺序。

- **型号**：优先有效的 EXIF/标准 Model；采用明确的非空字符串别名；对视频保留 Keys/XML group 优先级。同名 group 不按对象插入顺序随意决胜，`Copy1` 等实例后缀不能改变语义。型号冲突保留原始字段供检查，不把镜头名称、数字 ID 或盘名升级为 EXIF 确认型号。
- **拍摄日期**：使用同一 Original 家族：明确日期中的偏移/小数秒优先，其次同组唯一配对子字段，再用一致的 EXIF composite 补全。复制字段冲突时对应信息保持未知；XMP 等其他组不能借用 EXIF composite 的偏移。对于视频，优先明确记录内容创建时间且带偏移的 Keys CreationDate / Sony CreationDateValue，再考虑无偏移原始日期，最后才是 CreateDate 的数字化日期 composite 或容器日期。候选无效应继续检查下一个候选，不能由空字符串挡住有效值。
- **偏移**：保留 Z 或显式偏移。没有偏移就保持无偏移；不要附加电脑区域、盘卷名、GPS 推算时区或当前 DST。先实现标准 EXIF 与自身带偏移的日期，maker-note 模糊数字不参与。
- **目录日期**：使用选中拍摄时间自身的年月日。`2026-08-01T00:15:00+09:00` 仍进入 202608，不因 UTC 换算而落到七月。
- **比较**：只有双方有明确偏移时才能比较实际时刻；同一时刻的 `+09:00` 与 `Z` 不应冲突。双方无偏移时最多比较相机墙上时间；一方有偏移一方没有时，不把 JavaScript Date 的电脑时区解释当作证据。若要对亚毫秒时间判断严格相等，避免仅依赖 Date 的毫秒精度。
- **展示**：保留用于归类的日期和偏移；无偏移显示“时区未记录”。原始字段继续出现在 EXIF 检查器，便于发现真实相机差异。

建议回归样例：EXIF 分离偏移和小数秒、Composite 与 plain 并存、Copy1 同名字段、空/非字符串型号、Sony XML 型号和偏移日期、Apple Keys 与无偏移整数日期并存、同一时刻不同偏移、跨月午夜、非法日期/偏移、缺失时区以及未知 maker-note TimeZone 数字。纯标签 fixture 足以验证解析策略；不能把它们算作每个品牌硬件认证。

## Nikon MOV：已有明确字符串偏移的补充

复查本地已生成的 `build/hardware-a006/camera-routing-tags.json`，其中一条 Nikon MOV 记录同时包含：

```json
{
  "Nikon:DateTimeOriginal": "2026:08:02 17:02:03",
  "Nikon:CreateDate": "2026:08:02 17:02:03",
  "Nikon:Copy1:TimeZone": "+08:00",
  "Nikon:TimeZone": 480,
  "Nikon:DaylightSavings": 0,
  "QuickTime:Copy1:CreateDate": "2026:08:02 09:02:03"
}
```

这里只读取现有本地报告，没有重新打开 MOV 或访问外接卷。

ExifTool 的 **Nikon NCTG** 表明确对应 MOV 内的 NCTG 私有记录：`0x11` 解码为 CreateDate，`0x12` 为 DateTimeOriginal，`0x19` 为 TimeZone。该 TimeZone 没有数值到字符串的 ValueConv/PrintConv。`ProcessNikonMOV` 从每条记录读取其 EXIF 格式代码，再用 ReadValue 按实际格式取值；所以 `-n` 下仍返回的 `+08:00` 字符串不是应用或 PrintConv 把另一个数值 480 猜算出来的。这个字符串可以和同一 Nikon 日期来源作精确配对。需要保留证据限制：ExifTool 源码中对两个日期标签的命名有 guess 注释，这不是 Nikon 厂商正式规范的逐项认证。[官方 Nikon NCTG 标签表](https://exiftool.org/TagNames/Nikon.html#NCTG)、[官方 Nikon 源码中的 NCTG 和 ProcessNikonMOV](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Nikon.pm)、[可直接读取的官方标签文档源码](https://raw.githubusercontent.com/exiftool/exiftool/master/html/TagNames/Nikon.html)

因此可以增加一个窄规则，区别于前面拒绝的通用数字 TimeZone 推断：

- 仅当**被选中的日期也来自 Nikon group**，没有日期自身偏移、标准 EXIF 配对偏移或有效 composite 偏移时，检查同一 Nikon 来源的 `TimeZone` 字符串。
- 比较 group 时可忽略 ExifTool 实例标记 `Copy1`、`Copy2`；这些标记不是另一种时区单位，也不应使有效字符串被数字副本遮蔽。
- 只接受严格合法且唯一的显式 `±HH:MM` 字符串。多个副本表示同一偏移可合并；不同合法偏移发生冲突时保持未知，不按对象顺序选择。
- 忽略数字 `480`、数字字符串 `"480"`、城市/时区枚举以及 DaylightSavings，不再加减 DST。不能把 Nikon 字符串接到 QuickTime、Sony 或其他来源的无偏移日期上。
- 此记录可规范化为 `2026-08-02T17:02:03+08:00`；目录仍为相机记录的 202608。QuickTime 的 09:02:03 是旁证，**不能**通过两日期相差八小时反推时区。

建议追加四个回归：当前混合字符串/数字副本；仅数字480保持无偏移；两个冲突字符串保持未知；已有EXIF偏移不被Nikon副本覆盖。这项支持不意味着 Canon、Pentax 或全部 Nikon 数值时区已获同样解码支持。

## 本次实现与实测证据

权威入口仍为 `platform/metadata.metadataFromTags`，对外仍只返回一个规范化的 `Metadata.date`；没有新增第二套日期或时区接口。`CopyN` 只作为重复实例标记处理，不能把相互冲突的字段当成一致记录。主图标准 Model 优先于缩略图/XMP 的不同型号；有效 EXIF/IFD0/Composite/Nikon 原始日期优先，Sony XML 和带偏移 Apple Keys 内容日期再优先于通用容器 Original/CreateDate。

实际读取 A006 上的 Nikon NEF/JPG/MOV、Fujifilm RAF、Sony ARW/MP4，六份日期均保留了文件中记录的偏移，四份静态照片还保留了小数秒。结果见 `build/hardware-a006/camera-routing-normalized.json`，原始选取字段见 `camera-routing-tags.json`。各品牌标签 fixture 与真实文件读取分开计数；这不是所有品牌/型号的硬件认证。完整硬件和整理结果见 [A006 报告](hardware-a006-20261020.md)。

## 预览摘要与曝光参数

`Metadata.exposure` 由同一 `metadataFromTags` 入口生成，读取解码后的 LensModel、FNumber、ISO、ExposureTime、FocalLength 和 ExposureCompensation，单位分别为镜头名称、f 数、ISO、秒、毫米和 EV。不把数字 LensID 当名称，不把 APEX ShutterSpeedValue 当秒。未知字段保持未知，0 EV 是有效值。

预览按拍摄时记录的日历、时分秒和小数秒显示，时区独立显示为 UTC±HH:MM；不转换为电脑时区，也不补猜缺失时区。关键曝光参数保持紧凑，完整原始字段默认折叠，用户可展开并搜索。视频摘要不显示快门计数或其说明。

只读复查六份 A006 副本的结果见 `build/hardware-a006/camera-exposure-normalized.json`：Nikon NEF/JPG 与 Sony ARW 有完整曝光摘要；Fujifilm RAF 有曝光数据但没有镜头名称字段，不能从 X100VI 型号猜填名称。Sony MP4 普通元数据读取没有这些曝光值；单独诊断 `-ee` 产生逐帧曝光记录，快门值会随帧变化，因此不能把任意一帧的值标成整段视频的统一设置。保持快速默认读取，不全局开启嵌入时间序列提取。[ExifTool Sony 实现](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Sony.pm)
