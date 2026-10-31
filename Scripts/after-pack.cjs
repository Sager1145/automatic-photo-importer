// electron-builder afterPack: codesign refuses files with extended attributes ("resource fork, Finder information, or
// similar detritus not allowed"), which iCloud-synced or downloaded folders add. Clear them from the packaged app.
const {execFileSync}=require('node:child_process');
exports.default=async function afterPack(context){
 if(context.electronPlatformName!=='darwin')return;
 execFileSync('xattr',['-cr',context.appOutDir]);
};
