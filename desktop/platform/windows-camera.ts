/** The Windows camera bridge: the macOS helper's JSONL protocol ("list", "stage") over Windows Portable Devices.
 * Cameras in MTP/PTP mode have no drive letter; the Shell's portable-device namespace lists them and IFileOperation
 * copies each object off the camera. Nothing on the camera is ever changed or deleted. The script is constant: camera
 * ids and folders arrive as JSON on stdin, never as PowerShell code. */
const script = String.raw`
$ErrorActionPreference='Stop'
$utf8=New-Object Text.UTF8Encoding $false
$in=New-Object IO.StreamReader([Console]::OpenStandardInput(),$utf8)
$out=New-Object IO.StreamWriter([Console]::OpenStandardOutput(),$utf8);$out.AutoFlush=$true
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class CameraCopy {
 [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IShellItem {}
 [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IFileOperation {
  void Advise(IntPtr s, out uint c); void Unadvise(uint c); void SetOperationFlags(uint f);
  void SetProgressMessage(IntPtr m); void SetProgressDialog(IntPtr d); void SetProperties(IntPtr p);
  void SetOwnerWindow(IntPtr h); void ApplyPropertiesToItem(IntPtr i); void ApplyPropertiesToItems(IntPtr i);
  void RenameItem(IntPtr i, IntPtr n, IntPtr s); void RenameItems(IntPtr i, IntPtr n);
  void MoveItem(IntPtr i, IntPtr d, IntPtr n, IntPtr s); void MoveItems(IntPtr i, IntPtr d);
  void CopyItem(IShellItem i, IShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n, IntPtr s); void CopyItems(IntPtr i, IntPtr d);
  void DeleteItem(IntPtr i, IntPtr s); void DeleteItems(IntPtr i); void NewItem(); void PerformOperations();
  [return: MarshalAs(UnmanagedType.Bool)] bool GetAnyOperationsAborted();
 }
 [DllImport("shell32.dll", PreserveSig=false)] static extern void SHGetIDListFromObject([MarshalAs(UnmanagedType.IUnknown)] object o, out IntPtr p);
 [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)] static extern void SHParseDisplayName(string n, IntPtr b, out IntPtr p, uint i, out uint o);
 [DllImport("shell32.dll", PreserveSig=false)] static extern void SHCreateItemFromIDList(IntPtr p, [MarshalAs(UnmanagedType.LPStruct)] Guid r, [MarshalAs(UnmanagedType.Interface)] out IShellItem i);
 [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);
 static IShellItem Item(IntPtr pidl) { IShellItem i; try { SHCreateItemFromIDList(pidl, typeof(IShellItem).GUID, out i); } finally { CoTaskMemFree(pidl); } return i; }
 // MTP object paths cannot be parsed back by name, so the source comes from the enumerated item itself.
 public static void Copy(object source, string folder, string name) {
  IntPtr from, to; uint a; SHGetIDListFromObject(source, out from); IShellItem item = Item(from);
  SHParseDisplayName(folder, IntPtr.Zero, out to, 0, out a); IShellItem target = Item(to);
  var op = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
  op.SetOperationFlags(0x0004 | 0x0010 | 0x0200 | 0x0400); // silent, no prompts, no error dialogs
  op.CopyItem(item, target, name, IntPtr.Zero); op.PerformOperations();
  if (op.GetAnyOperationsAborted()) throw new Exception("The camera copy was cancelled.");
 }
}
"@
$shell=New-Object -ComObject Shell.Application
function Send($value){$out.WriteLine((ConvertTo-Json $value -Compress -Depth 5))}
# A camera is a non-filesystem item of This PC on the WPD device interface; card readers and mass-storage cameras have drive letters instead.
function Cameras{@($shell.NameSpace(17).Items()|Where-Object{-not $_.IsFileSystem -and $_.Path -match '\{6ac27878-a6fa-4155-ba85-f98f491d4f33\}'})}
function Safe([string]$name){$clean=($name -replace '[\x00-\x1f<>:"/\\|?*]','_').Trim().TrimEnd('.');if(-not $clean -or $clean -eq '.' -or $clean -eq '..'){'unnamed'}else{$clean}}
# A storage's own description names it ("SID-{10001,NIKON Z F   [Slot 1],...}" -> "Slot 1"); the Shell's name is localized.
function StorageName($item){if($item.Path -match 'SID-\{[^,]*,([^,\[]*(\[([^\]]+)\])?[^,]*),'){if($matches[3]){return Safe $matches[3]};$d=($matches[1] -replace '\s+',' ').Trim();if($d){return Safe $d}};Safe $item.Name}
function Storages($camera){@($camera.GetFolder.Items()|Where-Object{$_.IsFolder}|ForEach-Object{$t=$_.ExtendedProperty('System.Capacity');$f=$_.ExtendedProperty('System.FreeSpace');$o=@{name=(StorageName $_)};if($null -ne $t){$o.total=[int64]$t};if($null -ne $f){$o.free=[int64]$f};$o})}
function Files($folder,[string[]]$parts,$list){foreach($item in $folder.Items()){if($item.IsFolder){Files $item.GetFolder ($parts+(Safe $item.Name)) $list}else{$list.Add([pscustomobject]@{Item=$item;Parts=$parts})|Out-Null}}}
while($null -ne ($line=$in.ReadLine())){
 try{$command=ConvertFrom-Json $line}catch{continue}
 try{
  if($command.command -eq 'list'){Send @{id=$command.id;result=@(Cameras|ForEach-Object{@{name=$_.Name;cameraID=$_.Path;storages=@(Storages $_)}})}}
  elseif($command.command -eq 'stage'){
   $camera=Cameras|Where-Object{$_.Path -eq $command.cameraID}|Select-Object -First 1
   if(-not $camera){throw 'The camera is no longer connected.'}
   if(-not ([IO.Path]::IsPathRooted($command.directory)) -or -not (Test-Path -LiteralPath $command.directory -PathType Container)){throw 'Camera staging requires an existing absolute temporary folder.'}
   $staging=Join-Path $command.directory ('camera-'+[guid]::NewGuid());New-Item -ItemType Directory -Path $staging|Out-Null
   $list=New-Object Collections.ArrayList;foreach($storage in $camera.GetFolder.Items()){if($storage.IsFolder){Files $storage.GetFolder @(StorageName $storage) $list}else{$list.Add([pscustomobject]@{Item=$storage;Parts=@()})|Out-Null}}
   Send @{id=$command.id;progress=@{completed=0;total=$list.Count}}
   $used=@{};$index=0
   foreach($file in $list){
    $name=Safe $file.Item.Name;$folder=$staging;foreach($part in $file.Parts){$folder=Join-Path $folder $part}
    # Some cameras repeat a name in one folder: keep each copy apart instead of overwriting.
    if($used.ContainsKey((Join-Path $folder $name).ToLowerInvariant())){$folder=Join-Path $folder ('duplicate-'+$index+'-'+[guid]::NewGuid())}
    $used[(Join-Path $folder $name).ToLowerInvariant()]=$true
    New-Item -ItemType Directory -Force -Path $folder|Out-Null
    $target=Join-Path $folder $name
    if(Test-Path -LiteralPath $target){throw "Camera staging found an unexpected file: $target"}
    [CameraCopy]::Copy($file.Item,$folder,$name)
    $copied=Get-Item -LiteralPath $target -Force
    $size=$file.Item.ExtendedProperty('System.Size')
    if($null -ne $size -and [int64]$size -ne $copied.Length){throw "$($file.Item.Name): the camera reported $size bytes but $($copied.Length) arrived."}
    $index++;Send @{id=$command.id;progress=@{completed=$index;total=$list.Count}}
   }
   Send @{id=$command.id;result=@{path=$staging}}
  }
  else{Send @{id=$command.id;error='Unknown native camera command.'}}
 }catch{Send @{id=$command.id;error=[string]$_.Exception.Message}}
}
`;
/** powershell.exe arguments; -EncodedCommand keeps quoting out of the picture. */
export function windowsCameraBridgeArgs(): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}
