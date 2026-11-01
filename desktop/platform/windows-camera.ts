import { deflateRawSync } from 'node:zlib';

/** The Windows camera bridge: the macOS helper's JSONL protocol ("list", "files", "read", "release") over Windows
 * Portable Devices. Cameras in MTP/PTP mode have no drive letter; the Shell's portable-device namespace lists them and
 * their files (name, folder, size, dates and WPD object id; the 7,850 files of a Nikon Z f in about 10 s), and each file
 * is read straight from the device through the WPD API (IPortableDeviceResources::GetStream) in one session opened for
 * reading only, one byte range per request, so nothing is downloaded anywhere: the app hashes what it needs and writes
 * new files only into the destination. Measured on a Nikon Z f over USB: 150 MB/s through the WPD stream against
 * 110 MB/s for one Shell IFileOperation per file; the device serves one transfer at a time (a second session is
 * refused), and buffers larger than the driver's optimal size change nothing. An object's stream stays open between
 * requests for consecutive ranges, so a file read in order is one stream; a range further on is reached by Seek, or by
 * reading up to it where the driver cannot seek. Nothing on the camera is ever changed or deleted. The script is
 * constant: camera and object ids arrive as JSON on stdin, never as PowerShell code. A reply carrying file data is
 * written by the C# reader itself, as one line: {"id":…,"result":{"bytes":n,"data":"<base64>"}}. */
const script = String.raw`
$ErrorActionPreference='Stop'
$utf8=New-Object Text.UTF8Encoding $false
$in=New-Object IO.StreamReader([Console]::OpenStandardInput(),$utf8)
$out=New-Object IO.StreamWriter([Console]::OpenStandardOutput(),$utf8);$out.AutoFlush=$true
Add-Type -TypeDefinition @"
using System; using System.IO; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public static class CameraRead {
 [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid fmtid; public uint pid; }
 // Only the vtable slots up to the last method called are declared; the later ones are never reached.
 [ComImport, Guid("6848F6F2-3155-4F86-B6F5-263EEEAB3143"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IPortableDeviceValues {
  void GetCount(out uint c); void GetAt(uint i, IntPtr k, IntPtr v); void SetValue(IntPtr k, IntPtr v); void GetValue(IntPtr k, IntPtr v);
  void SetStringValue(ref PropertyKey k, [MarshalAs(UnmanagedType.LPWStr)] string v); void GetStringValue(ref PropertyKey k, [MarshalAs(UnmanagedType.LPWStr)] out string v);
  void SetUnsignedIntegerValue(ref PropertyKey k, uint v); void GetUnsignedIntegerValue(ref PropertyKey k, out uint v);
  void SetSignedIntegerValue(ref PropertyKey k, int v); void GetSignedIntegerValue(ref PropertyKey k, out int v);
  void SetUnsignedLargeIntegerValue(ref PropertyKey k, ulong v); void GetUnsignedLargeIntegerValue(ref PropertyKey k, out ulong v);
  void SetSignedLargeIntegerValue(ref PropertyKey k, long v); void GetSignedLargeIntegerValue(ref PropertyKey k, out long v);
  void SetFloatValue(ref PropertyKey k, float v); void GetFloatValue(ref PropertyKey k, out float v);
  void SetErrorValue(ref PropertyKey k, int v); void GetErrorValue(ref PropertyKey k, out int v);
  void SetKeyValue(ref PropertyKey k, ref PropertyKey v); void GetKeyValue(ref PropertyKey k, out PropertyKey v);
  void SetBoolValue(ref PropertyKey k, int v); void GetBoolValue(ref PropertyKey k, out int v);
  void SetIUnknownValue(ref PropertyKey k, [MarshalAs(UnmanagedType.IUnknown)] object v); void GetIUnknownValue(ref PropertyKey k, [MarshalAs(UnmanagedType.IUnknown)] out object v);
  void SetGuidValue(ref PropertyKey k, ref Guid v); void GetGuidValue(ref PropertyKey k, out Guid v);
  // A managed array here corrupts memory past 256 KB (measured); the buffer goes as unmanaged memory.
  void SetBufferValue(ref PropertyKey k, IntPtr v, uint n); void GetBufferValue(ref PropertyKey k, out IntPtr v, out uint n);
  void SetIPortableDeviceValuesValue(ref PropertyKey k, IPortableDeviceValues v); void GetIPortableDeviceValuesValue(ref PropertyKey k, out IPortableDeviceValues v);
  void SetIPortableDevicePropVariantCollectionValue(ref PropertyKey k, IPortableDevicePropVariantCollection v);
 }
 [ComImport, Guid("89B2E422-4F1B-4316-BCEF-A44AFEA83EB3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IPortableDevicePropVariantCollection { void GetCount(out uint c); void GetAt(uint i, IntPtr v); void Add(IntPtr v); }
 [ComImport, Guid("FD8878AC-D841-4D17-891C-E6829CDB6934"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IPortableDeviceResources {
  void GetSupportedResources(); void GetResourceAttributes();
  void GetStream([MarshalAs(UnmanagedType.LPWStr)] string id, ref PropertyKey key, uint mode, ref uint optimal, out IStream stream);
 }
 [ComImport, Guid("6A96ED84-7C73-4480-9938-BF5AF477D426"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IPortableDeviceContent { void EnumObjects(); void Properties(); void Transfer(out IPortableDeviceResources r); }
 [ComImport, Guid("625E2DF8-6392-4CF0-9AD1-3CFA5F17775C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IPortableDevice {
  void Open([MarshalAs(UnmanagedType.LPWStr)] string id, IPortableDeviceValues info); void SendCommand(uint flags, IPortableDeviceValues p, out IPortableDeviceValues r);
  void Content(out IPortableDeviceContent c); void Capabilities(); void Cancel(); void Close();
 }
 class Reader { public IStream stream; public long position; public int optimal; }
 static IPortableDevice device; static IPortableDeviceResources resources; static string session; static bool partial;
 static readonly Dictionary<string,Reader> readers = new Dictionary<string,Reader>();
 static readonly Guid Common = new Guid("F0422A9C-5DC8-4440-B5BD-5DF28835658A"), Mtp = new Guid("4D545058-1A2E-4106-A357-771E0819FC56");
 static PropertyKey Key(Guid g, uint p) { return new PropertyKey { fmtid = g, pid = p }; }
 static IPortableDeviceValues Values() { return (IPortableDeviceValues)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("0C15D503-D017-47CE-9016-7B3F978721CC"))); }
 // One session per camera, kept while requests name the same one. WPD passes MTP operations only to a session opened
 // for reading and writing (a read-only one gets E_ACCESSDENIED); the only operations ever sent are GetPartialObject
 // and GetPartialObject64, which read.
 static void Open(string pnp) {
  if (resources != null && session == pnp) return;
  Close();
  var info = Values(); var access = Key(new Guid("204D9F0C-2292-4080-9F42-40664E70F859"), 9); info.SetUnsignedIntegerValue(ref access, 0xC0000000);
  var opened = (IPortableDevice)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("728A21C5-3D9E-48D7-9810-864848F0F404")));
  opened.Open(pnp, info); device = opened; IPortableDeviceContent content; device.Content(out content); content.Transfer(out resources); session = pnp; partial = true;
 }
 static IPortableDeviceValues Command(uint id) { var v = Values(); var category = Key(Common, 1001); var mtp = Mtp; v.SetGuidValue(ref category, ref mtp); var command = Key(Common, 1002); v.SetUnsignedIntegerValue(ref command, id); return v; }
 static IPortableDeviceValues Send(IPortableDeviceValues p) { IPortableDeviceValues r; device.SendCommand(0, p, out r); int hr; var key = Key(Common, 1003); r.GetErrorValue(ref key, out hr); if (hr != 0) throw new COMException("The camera refused the read.", hr); return r; }
 // MTP GetPartialObject (GetPartialObject64 past 4 GB) reads exactly the range. A WPD stream reads an MTP object whole
 // even when only its first bytes are wanted (60 headers of 512 KB: 31 s that way, 0.67 s here); 16 MB ranges run at
 // the stream's full 150 MB/s. The object id of the inbox MTP driver is "o" and the object handle in hex.
 static int Partial(string objectId, long offset, byte[] target, int length) {
  uint handle; if (objectId.Length < 2 || objectId[0] != 'o' || !UInt32.TryParse(objectId.Substring(1), System.Globalization.NumberStyles.HexNumber, null, out handle)) throw new NotSupportedException();
  var p = Command(13); var op = Key(Mtp, 1001); bool wide = offset > UInt32.MaxValue; p.SetUnsignedIntegerValue(ref op, wide ? 0x95C1u : 0x101Bu); // EXECUTE_COMMAND_WITH_DATA_TO_READ
  var list = (IPortableDevicePropVariantCollection)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("08A99E2F-6D6D-4B80-AF5A-BAF2BCBE4CB9")));
  var parameters = wide ? new uint[] { handle, (uint)offset, (uint)(offset >> 32), (uint)length } : new uint[] { handle, (uint)offset, (uint)length };
  IntPtr value = Marshal.AllocHGlobal(24); // a PROPVARIANT holding VT_UI4
  try { foreach (var item in parameters) { for (int i = 0; i < 24; i++) Marshal.WriteByte(value, i, 0); Marshal.WriteInt16(value, 0, 19); Marshal.WriteInt32(value, 8, (int)item); list.Add(value); } } finally { Marshal.FreeHGlobal(value); }
  var pk = Key(Mtp, 1002); p.SetIPortableDevicePropVariantCollectionValue(ref pk, list);
  var started = Send(p); string context; var ck = Key(Mtp, 1006); started.GetStringValue(ref ck, out context);
  ulong total; var tk = Key(Mtp, 1007); started.GetUnsignedLargeIntegerValue(ref tk, out total);
  int done = 0; bool read = false;
  try {
   while ((ulong)done < total && done < length) {
    uint want = (uint)Math.Min(Math.Min(total - (ulong)done, (ulong)(length - done)), 4u << 20);
    var q = Command(15); q.SetStringValue(ref ck, context); var nk = Key(Mtp, 1008); q.SetUnsignedIntegerValue(ref nk, want); // READ_DATA
    var dk = Key(Mtp, 1012); IntPtr space = Marshal.AllocHGlobal((int)want); try { q.SetBufferValue(ref dk, space, want); } finally { Marshal.FreeHGlobal(space); }
    var r = Send(q); IntPtr data; uint n; r.GetBufferValue(ref dk, out data, out n); uint got; var gk = Key(Mtp, 1009); r.GetUnsignedIntegerValue(ref gk, out got);
    try { got = Math.Min(got, Math.Min(n, want)); Marshal.Copy(data, target, done, (int)got); } finally { Marshal.FreeCoTaskMem(data); }
    if (got == 0) break; done += (int)got;
   }
   read = true;
  } finally {
   var e = Command(17); e.SetStringValue(ref ck, context); var f = Send(e); uint code; var rk = Key(Mtp, 1003); f.GetUnsignedIntegerValue(ref rk, out code); // END_DATA_TRANSFER
   if (read && code != 0x2001) throw new Exception("The camera answered 0x" + code.ToString("X4") + " to a read.");
  }
  return done;
 }
 public static void Release(string objectId) { Reader reader; if (objectId != null && readers.TryGetValue(objectId, out reader)) { readers.Remove(objectId); try { Marshal.ReleaseComObject(reader.stream); } catch {} } }
 public static void Close() {
  foreach (var reader in readers.Values) { try { Marshal.ReleaseComObject(reader.stream); } catch {} }
  readers.Clear();
  try { if (device != null) device.Close(); } catch {}
  device = null; resources = null; session = null;
 }
 static Reader Stream(string objectId) {
  // A few files may be open at once (a header read while another file streams); past that, all go and are reopened on demand.
  if (readers.Count >= 4) { foreach (var key in new List<string>(readers.Keys)) Release(key); }
  var data = new PropertyKey { fmtid = new Guid("E81E79BE-34F0-41BF-B53F-F1A06AE87842"), pid = 0 }; // WPD_RESOURCE_DEFAULT
  uint optimal = 0; IStream stream; resources.GetStream(objectId, ref data, 0, ref optimal, out stream);
  var reader = new Reader { stream = stream, position = 0, optimal = (int)Math.Min(Math.Max(optimal, 65536u), 4u << 20) };
  readers[objectId] = reader; return reader;
 }
 // Reads count bytes into target (or discards them when target is null); fewer only at the end of the object.
 static int Fill(Reader reader, byte[] target, int offset, int count) {
  var chunk = new byte[Math.Min(reader.optimal, Math.Max(count, 1))]; IntPtr read = Marshal.AllocCoTaskMem(4); int total = 0;
  try {
   while (total < count) {
    int want = Math.Min(chunk.Length, count - total); reader.stream.Read(chunk, want, read); int n = Marshal.ReadInt32(read);
    if (n <= 0) break;
    if (target != null) Buffer.BlockCopy(chunk, 0, target, offset + total, n);
    total += n; reader.position += n;
   }
  } finally { Marshal.FreeCoTaskMem(read); }
  return total;
 }
 // Where a camera has no partial reads: the object's WPD stream, kept open for the next range, sought (or read up to) further on.
 static int Streamed(string objectId, long offset, byte[] buffer, int length) {
  Reader reader;
  if (!readers.TryGetValue(objectId, out reader) || reader.position > offset) { Release(objectId); reader = Stream(objectId); }
  if (reader.position < offset) {
   bool sought = false;
   try { IntPtr at = Marshal.AllocCoTaskMem(8); try { reader.stream.Seek(offset, 0, at); sought = Marshal.ReadInt64(at) == offset; } finally { Marshal.FreeCoTaskMem(at); } } catch {}
   if (sought) reader.position = offset;
   else { Release(objectId); reader = Stream(objectId); while (reader.position < offset) { if (Fill(reader, null, 0, (int)Math.Min(offset - reader.position, 4 << 20)) == 0) break; } }
  }
  return reader.position == offset ? Fill(reader, buffer, 0, length) : 0;
 }
 // Every line out goes through here, whole, from this thread or the writer's.
 static readonly object writing = new object();
 static System.Threading.Tasks.Task written = System.Threading.Tasks.Task.FromResult(0);
 public static void Line(TextWriter output, string text) { lock (writing) { output.Write(text); output.Write('\n'); } }
 // Up to length bytes of the object from offset (fewer only at its end), sent as one JSONL reply. The reply is encoded
 // and written in the background while the next request reads the camera (one reply at most waits): written in line,
 // 16 MB took as long to send as to read, and the transfer ran at 95 MB/s instead of the camera's 150.
 public static void Read(TextWriter output, string id, string pnp, string objectId, long offset, int length) {
  if (String.IsNullOrEmpty(objectId) || offset < 0 || length < 0 || length > (64 << 20)) throw new ArgumentException("Invalid camera read.");
  Open(pnp);
  var buffer = new byte[length]; int bytes = -1;
  // A camera (or driver) without partial reads is read through its streams for the rest of the session.
  if (partial) { try { bytes = Partial(objectId, offset, buffer, length); } catch (NotSupportedException) { partial = false; } catch (COMException error) { if (error.ErrorCode != unchecked((int)0x80070005) && error.ErrorCode != unchecked((int)0x80070032)) throw; partial = false; } }
  if (bytes < 0) bytes = Streamed(objectId, offset, buffer, length);
  written.Wait();
  int count = bytes;
  written = System.Threading.Tasks.Task.Run(() => Line(output, "{\"id\":\"" + id + "\",\"result\":{\"bytes\":" + count + ",\"data\":\"" + Convert.ToBase64String(buffer, 0, count) + "\"}}"));
 }
}
"@
$shell=New-Object -ComObject Shell.Application
function Send($value){[CameraRead]::Line($out,(ConvertTo-Json $value -Compress -Depth 5))}
# A camera is a non-filesystem item of This PC on the WPD device interface; card readers and mass-storage cameras have drive letters instead.
function Cameras{@($shell.NameSpace(17).Items()|Where-Object{-not $_.IsFileSystem -and $_.Path -match '\{6ac27878-a6fa-4155-ba85-f98f491d4f33\}'})}
function Camera($id){$found=Cameras|Where-Object{$_.Path -eq $id}|Select-Object -First 1;if(-not $found){throw 'The camera is no longer connected.'};$found}
# The device's PnP path follows This PC's prefix in the camera's Shell path.
function Pnp([string]$id){$id.Substring([Math]::Max(0,$id.IndexOf('\\?\')))}
function Safe([string]$name){$clean=($name -replace '[\x00-\x1f<>:"/\\|?*]','_').Trim().TrimEnd('.');if(-not $clean -or $clean -eq '.' -or $clean -eq '..'){'unnamed'}else{$clean}}
# A storage's own description names it ("SID-{10001,NIKON Z F   [Slot 1],...}" -> "Slot 1"); the Shell's name is localized.
function StorageName($item){if($item.Path -match 'SID-\{[^,]*,([^,\[]*(\[([^\]]+)\])?[^,]*),'){if($matches[3]){return Safe $matches[3]};$d=($matches[1] -replace '\s+',' ').Trim();if($d){return Safe $d}};Safe $item.Name}
function Storages($camera){@($camera.GetFolder.Items()|Where-Object{$_.IsFolder}|ForEach-Object{$t=$_.ExtendedProperty('System.Capacity');$f=$_.ExtendedProperty('System.FreeSpace');$o=@{name=(StorageName $_)};if($null -ne $t){$o.total=[int64]$t};if($null -ne $f){$o.free=[int64]$f};$o})}
$epoch=New-Object DateTime 1970,1,1,0,0,0,([DateTimeKind]::Utc)
function J([string]$text){'"'+($text -replace '\\','\\' -replace '"','\"' -replace '[\x00-\x1f]',' ')+'"'}
# The listing is written as JSON by hand, the folder part once per folder: ConvertTo-Json, or a function call per file,
# costs PowerShell seconds over thousands of files (93 s for 7,850, against 10 s like this).
function Walk($folder,[string[]]$parts,[string]$storage,$list,$id){
 $head='{"storage":'+(J $storage)+',"folder":['+((@($parts)|ForEach-Object{J $_}) -join ',')+'],"name":"'
 foreach($item in $folder.Items()){
  if($item.IsFolder){Walk $item.GetFolder ($parts+(Safe $item.Name)) $storage $list $id;continue}
  $name=$item.ExtendedProperty('System.FileName');if(-not $name){$name=$item.Name}
  # As Safe: no quote, backslash or control character is left in a name, so it needs no JSON escaping.
  $name=([string]$name -replace '[\x00-\x1f<>:"/\\|?*]','_').Trim().TrimEnd('.');if(-not $name -or $name -eq '.' -or $name -eq '..'){$name='unnamed'}
  $text=$head+$name+'","objectID":"'+([string]$item.ExtendedProperty('{EF6B490D-5CD8-437A-AFFC-DA8B60EE4A3C} 2') -replace '\\','\\' -replace '"','\"' -replace '[\x00-\x1f]',' ')+'"'
  $size=$item.ExtendedProperty('System.Size');if($null -ne $size){$text+=',"size":'+[int64]$size}
  # The Shell gives an MTP object's dates in the camera's clock, as local time.
  $date=$item.ExtendedProperty('System.DateModified');if($date -is [DateTime]){$text+=',"modified":'+[int64]($date.ToUniversalTime()-$epoch).TotalMilliseconds}
  $date=$item.ExtendedProperty('System.DateCreated');if($date -is [DateTime]){$text+=',"created":'+[int64]($date.ToUniversalTime()-$epoch).TotalMilliseconds}
  $list.Add($text+'}')|Out-Null
  # A progress line every 250 files keeps the request's timeout from running out on a large card.
  if($list.Count%250 -eq 0){Send @{id=$id;progress=@{completed=$list.Count;total=0}}}
 }
}
while($null -ne ($line=$in.ReadLine())){
 try{$command=ConvertFrom-Json $line}catch{continue}
 try{
  if($command.command -eq 'list'){Send @{id=$command.id;result=@(Cameras|ForEach-Object{@{name=$_.Name;cameraID=$_.Path;storages=@(Storages $_)}})}}
  elseif($command.command -eq 'files'){
   $camera=Camera $command.cameraID;$list=New-Object Collections.ArrayList
   foreach($storage in $camera.GetFolder.Items()){if($storage.IsFolder){$name=StorageName $storage;if(-not $command.storage -or $command.storage -eq $name){Walk $storage.GetFolder @() $name $list $command.id}}}
   [CameraRead]::Line($out,'{"id":'+(J $command.id)+',"result":['+($list -join ',')+']}')
  }
  elseif($command.command -eq 'read'){[CameraRead]::Read($out,[string]$command.id,(Pnp ([string]$command.cameraID)),[string]$command.objectID,[int64]$command.offset,[int]$command.length)}
  elseif($command.command -eq 'release'){[CameraRead]::Release([string]$command.objectID);Send @{id=$command.id;result=$true}}
  else{Send @{id=$command.id;error='Unknown native camera command.'}}
 }catch{[CameraRead]::Close();Send @{id=$command.id;error=[string]$_.Exception.Message}}
}
`;
/** powershell.exe arguments; -EncodedCommand keeps quoting out of the picture. The script travels deflated inside a
 * short loader that inflates and runs it: as UTF-16 base64 it would pass the 32,767-character command line limit. */
export function windowsCameraBridgeArgs(): string[] {
  const packed = deflateRawSync(Buffer.from(script, 'utf8'), { level: 9 }).toString('base64');
  const loader = `$z=New-Object IO.Compression.DeflateStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String('${packed}'))),[IO.Compression.CompressionMode]::Decompress);Invoke-Expression ((New-Object IO.StreamReader($z,(New-Object Text.UTF8Encoding $false))).ReadToEnd())`;
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(loader, 'utf16le').toString('base64')];
}
